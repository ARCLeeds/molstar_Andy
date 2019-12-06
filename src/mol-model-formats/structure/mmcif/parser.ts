/**
 * Copyright (c) 2017-2019 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author David Sehnal <david.sehnal@gmail.com>
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

import { Column, Table } from '../../../mol-data/db';
import { mmCIF_Database, mmCIF_Schema } from '../../../mol-io/reader/cif/schema/mmcif';
import { Spacegroup, SpacegroupCell, SymmetryOperator } from '../../../mol-math/geometry';
import { Tensor, Vec3, Mat3 } from '../../../mol-math/linear-algebra';
import { RuntimeContext } from '../../../mol-task';
import UUID from '../../../mol-util/uuid';
import { Model } from '../../../mol-model/structure/model/model';
import { Entities, ChemicalComponent, MissingResidue, EntitySubtype } from '../../../mol-model/structure/model/properties/common';
import { CustomProperties } from '../../../mol-model/structure';
import { ModelSymmetry } from '../../../mol-model/structure/model/properties/symmetry';
import { createAssemblies } from './assembly';
import { getAtomicHierarchyAndConformation } from './atomic';
import { ComponentBond } from './bonds';
import { getIHMCoarse, EmptyIHMCoarse, IHMData } from './ihm';
import { getSecondaryStructure } from './secondary-structure';
import { getSequence } from './sequence';
import { sortAtomSite } from './sort';
import { StructConn } from './bonds/struct_conn';
import { getMoleculeType, MoleculeType, getEntityType, getEntitySubtype, getDefaultChemicalComponent } from '../../../mol-model/structure/model/types';
import { ModelFormat } from '../format';
import { SaccharideComponentMap, SaccharideComponent, SaccharidesSnfgMap, SaccharideCompIdMap, UnknownSaccharideComponent } from '../../../mol-model/structure/structure/carbohydrates/constants';
import mmCIF_Format = ModelFormat.mmCIF
import { memoize1 } from '../../../mol-util/memoize';
import { ElementIndex, EntityIndex } from '../../../mol-model/structure/model';
import { AtomSiteAnisotrop } from './anisotropic';
import { getAtomicRanges } from '../../../mol-model/structure/model/properties/utils/atomic-ranges';

export async function _parse_mmCif(format: mmCIF_Format, ctx: RuntimeContext) {
    const formatData = getFormatData(format)
    const isIHM = format.data.ihm_model_list._rowCount > 0;
    return isIHM ? await readIHM(ctx, format, formatData) : await readStandard(ctx, format, formatData);
}

type AtomSite = mmCIF_Database['atom_site']

function getSymmetry(format: mmCIF_Format): ModelSymmetry {
    const assemblies = createAssemblies(format);
    const spacegroup = getSpacegroup(format);
    const isNonStandardCrytalFrame = checkNonStandardCrystalFrame(format, spacegroup);
    return { assemblies, spacegroup, isNonStandardCrytalFrame, ncsOperators: getNcsOperators(format) };
}

function checkNonStandardCrystalFrame(format: mmCIF_Format, spacegroup: Spacegroup) {
    const { atom_sites } = format.data;
    if (atom_sites._rowCount === 0) return false;
    // TODO: parse atom_sites transform and check if it corresponds to the toFractional matrix
    return false;
}

function getSpacegroupNameOrNumber(symmetry: mmCIF_Format['data']['symmetry']) {
    const groupNumber = symmetry['Int_Tables_number'].value(0);
    const groupName = symmetry['space_group_name_H-M'].value(0);
    if (!symmetry['Int_Tables_number'].isDefined) return groupName
    if (!symmetry['space_group_name_H-M'].isDefined) return groupNumber
    return groupName
}

function getSpacegroup(format: mmCIF_Format): Spacegroup {
    const { symmetry, cell } = format.data;
    if (symmetry._rowCount === 0 || cell._rowCount === 0) return Spacegroup.ZeroP1;
    const nameOrNumber = getSpacegroupNameOrNumber(symmetry)
    const spaceCell = SpacegroupCell.create(nameOrNumber,
        Vec3.create(cell.length_a.value(0), cell.length_b.value(0), cell.length_c.value(0)),
        Vec3.scale(Vec3.zero(), Vec3.create(cell.angle_alpha.value(0), cell.angle_beta.value(0), cell.angle_gamma.value(0)), Math.PI / 180));

    return Spacegroup.create(spaceCell);
}

function getNcsOperators(format: mmCIF_Format) {
    const { struct_ncs_oper } = format.data;
    if (struct_ncs_oper._rowCount === 0) return void 0;
    const { id, matrix, vector } = struct_ncs_oper;

    const matrixSpace = mmCIF_Schema.struct_ncs_oper.matrix.space, vectorSpace = mmCIF_Schema.struct_ncs_oper.vector.space;

    const opers: SymmetryOperator[] = [];
    for (let i = 0; i < struct_ncs_oper._rowCount; i++) {
        const m = Tensor.toMat3(Mat3(), matrixSpace, matrix.value(i));
        const v = Tensor.toVec3(Vec3(), vectorSpace, vector.value(i));
        if (!SymmetryOperator.checkIfRotationAndTranslation(m, v)) continue;
        // ignore non-identity 'given' NCS operators
        if (struct_ncs_oper.code.value(i) === 'given' && !Mat3.isIdentity(m) && !Vec3.isZero(v)) continue;
        const ncsId = id.value(i)
        opers[opers.length] = SymmetryOperator.ofRotationAndOffset(`ncs_${ncsId}`, m, v, ncsId);
    }
    return opers;
}

function getModifiedResidueNameMap(format: mmCIF_Format): Model['properties']['modifiedResidues'] {
    const data = format.data.pdbx_struct_mod_residue;
    const parentId = new Map<string, string>();
    const details = new Map<string, string>();
    const comp_id = data.label_comp_id.isDefined ? data.label_comp_id : data.auth_comp_id;
    const parent_id = data.parent_comp_id, details_data = data.details;

    for (let i = 0; i < data._rowCount; i++) {
        const id = comp_id.value(i);
        parentId.set(id, parent_id.value(i));
        details.set(id, details_data.value(i));
    }

    return { parentId, details };
}

function getMissingResidues(format: mmCIF_Format): Model['properties']['missingResidues'] {
    const map = new Map<string, MissingResidue>();
    const c = format.data.pdbx_unobs_or_zero_occ_residues

    const getKey = (model_num: number, asym_id: string, seq_id: number) => {
        return `${model_num}|${asym_id}|${seq_id}`
    }

    for (let i = 0, il = c._rowCount; i < il; ++i) {
        const key = getKey(c.PDB_model_num.value(i), c.label_asym_id.value(i), c.label_seq_id.value(i))
        map.set(key, { polymer_flag: c.polymer_flag.value(i), occupancy_flag: c.occupancy_flag.value(i) })
    }

    return {
        has: (model_num: number, asym_id: string, seq_id: number) => {
            return map.has(getKey(model_num, asym_id, seq_id))
        },
        get: (model_num: number, asym_id: string, seq_id: number) => {
            return map.get(getKey(model_num, asym_id, seq_id))
        },
        size: map.size
    }
}

function getChemicalComponentMap(format: mmCIF_Format): Model['properties']['chemicalComponentMap'] {
    const map = new Map<string, ChemicalComponent>();
    const { chem_comp } = format.data

    if (chem_comp._rowCount > 0) {
        const { id } = chem_comp
        for (let i = 0, il = id.rowCount; i < il; ++i) {
            map.set(id.value(i), Table.getRow(chem_comp, i))
        }
    } else {
        const uniqueNames = getUniqueComponentNames(format);
        uniqueNames.forEach(n => {
            map.set(n, getDefaultChemicalComponent(n));
        });
    }
    return map
}

function getSaccharideComponentMap(format: mmCIF_Format): SaccharideComponentMap {
    const map = new Map<string, SaccharideComponent>();

    if (format.data.pdbx_chem_comp_identifier._rowCount > 0) {
        // note that `pdbx_chem_comp_identifier` does not contain
        // a 'SNFG CARBOHYDRATE SYMBOL' entry for 'Unknown' saccharide components
        // so we always need to check `chem_comp` for those
        const { comp_id, type, identifier } = format.data.pdbx_chem_comp_identifier
        for (let i = 0, il = comp_id.rowCount; i < il; ++i) {
            if (type.value(i) === 'SNFG CARBOHYDRATE SYMBOL' ||
                type.value(i) === 'SNFG CARB SYMBOL' // legacy, to be removed from mmCIF dictionary
            ) {
                const snfgName = identifier.value(i)
                const saccharideComp = SaccharidesSnfgMap.get(snfgName)
                if (saccharideComp) {
                    map.set(comp_id.value(i), saccharideComp)
                } else {
                    console.warn(`Unknown SNFG name '${snfgName}'`)
                }
            }
        }
    }

    if (format.data.chem_comp._rowCount > 0) {
        const { id, type  } = format.data.chem_comp
        for (let i = 0, il = id.rowCount; i < il; ++i) {
            const _id = id.value(i)
            if (map.has(_id)) continue
            const _type = type.value(i)
            if (SaccharideCompIdMap.has(_id)) {
                map.set(_id, SaccharideCompIdMap.get(_id)!)
            } else if (getMoleculeType(_type, _id) === MoleculeType.Saccharide) {
                map.set(_id, UnknownSaccharideComponent)
            }
        }
    } else {
        const uniqueNames = getUniqueComponentNames(format)
        SaccharideCompIdMap.forEach((v, k) => {
            if (!map.has(k) && uniqueNames.has(k)) map.set(k, v)
        })
    }
    return map
}

const getUniqueComponentNames = memoize1((format: mmCIF_Format) => {
    const uniqueNames = new Set<string>()
    const data = format.data.atom_site
    const comp_id = data.label_comp_id.isDefined ? data.label_comp_id : data.auth_comp_id;
    for (let i = 0, il = comp_id.rowCount; i < il; ++i) {
        uniqueNames.add(comp_id.value(i))
    }
    return uniqueNames
})

export interface FormatData {
    modifiedResidues: Model['properties']['modifiedResidues']
    missingResidues: Model['properties']['missingResidues']
    chemicalComponentMap: Model['properties']['chemicalComponentMap']
    saccharideComponentMap: Model['properties']['saccharideComponentMap']
}

function getFormatData(format: mmCIF_Format): FormatData {
    return {
        modifiedResidues: getModifiedResidueNameMap(format),
        missingResidues: getMissingResidues(format),
        chemicalComponentMap: getChemicalComponentMap(format),
        saccharideComponentMap: getSaccharideComponentMap(format)
    }
}

function createStandardModel(format: mmCIF_Format, atom_site: AtomSite, sourceIndex: Column<number>, entities: Entities, formatData: FormatData, previous?: Model): Model {
    const atomic = getAtomicHierarchyAndConformation(atom_site, sourceIndex, entities, formatData, previous);
    const modelNum = atom_site.pdbx_PDB_model_num.value(0)
    if (previous && atomic.sameAsPrevious) {
        return {
            ...previous,
            id: UUID.create22(),
            modelNum,
            atomicConformation: atomic.conformation,
            _dynamicPropertyData: Object.create(null)
        };
    }

    const coarse = EmptyIHMCoarse;
    const sequence = getSequence(format.data, entities, atomic.hierarchy, coarse.hierarchy, formatData.modifiedResidues.parentId)
    const atomicRanges = getAtomicRanges(atomic.hierarchy, entities, atomic.conformation, sequence)

    const entry = format.data.entry.id.valueKind(0) === Column.ValueKind.Present
        ? format.data.entry.id.value(0)
        : format.data._name;

    const label: string[] = []
    if (entry) label.push(entry)
    if (format.data.struct.title.valueKind(0) === Column.ValueKind.Present) label.push(format.data.struct.title.value(0))

    return {
        id: UUID.create22(),
        entryId: entry,
        label: label.join(' | '),
        entry,
        sourceData: format,
        modelNum,
        entities,
        symmetry: getSymmetry(format),
        sequence,
        atomicHierarchy: atomic.hierarchy,
        atomicConformation: atomic.conformation,
        atomicRanges,
        coarseHierarchy: coarse.hierarchy,
        coarseConformation: coarse.conformation,
        properties: {
            secondaryStructure: getSecondaryStructure(format.data, atomic.hierarchy),
            ...formatData
        },
        customProperties: new CustomProperties(),
        _staticPropertyData: Object.create(null),
        _dynamicPropertyData: Object.create(null)
    };
}

function createModelIHM(format: mmCIF_Format, data: IHMData, formatData: FormatData): Model {
    const atomic = getAtomicHierarchyAndConformation(data.atom_site, data.atom_site_sourceIndex, data.entities, formatData);
    const coarse = getIHMCoarse(data, formatData);
    const sequence = getSequence(format.data, data.entities, atomic.hierarchy, coarse.hierarchy, formatData.modifiedResidues.parentId)
    const atomicRanges = getAtomicRanges(atomic.hierarchy, data.entities, atomic.conformation, sequence)

    const entry = format.data.entry.id.valueKind(0) === Column.ValueKind.Present
        ? format.data.entry.id.value(0)
        : format.data._name;

    const label: string[] = []
    if (entry) label.push(entry)
    if (format.data.struct.title.valueKind(0) === Column.ValueKind.Present) label.push(format.data.struct.title.value(0))
    if (data.model_group_name) label.push(data.model_name)
    if (data.model_group_name) label.push(data.model_group_name)

    return {
        id: UUID.create22(),
        entryId: entry,
        label: label.join(' | '),
        entry,
        sourceData: format,
        modelNum: data.model_id,
        entities: data.entities,
        symmetry: getSymmetry(format),
        sequence,
        atomicHierarchy: atomic.hierarchy,
        atomicConformation: atomic.conformation,
        atomicRanges,
        coarseHierarchy: coarse.hierarchy,
        coarseConformation: coarse.conformation,
        properties: {
            secondaryStructure: getSecondaryStructure(format.data, atomic.hierarchy),
            ...formatData
        },
        customProperties: new CustomProperties(),
        _staticPropertyData: Object.create(null),
        _dynamicPropertyData: Object.create(null)
    };
}

function attachProps(model: Model) {
    ComponentBond.attachFromMmCif(model);
    StructConn.attachFromMmCif(model);
    AtomSiteAnisotrop.attachFromMmCif(model);
}

function findModelEnd(num: Column<number>, startIndex: number) {
    const rowCount = num.rowCount;
    if (!num.isDefined) return rowCount;
    let endIndex = startIndex + 1;
    while (endIndex < rowCount && num.areValuesEqual(startIndex, endIndex)) endIndex++;
    return endIndex;
}

function getEntities(format: mmCIF_Format): Entities {
    let entityData: Table<mmCIF_Schema['entity']>

    if (!format.data.entity.id.isDefined) {
        const entityIds = new Set<string>()

        const ids: mmCIF_Schema['entity']['id']['T'][] = []
        const types: mmCIF_Schema['entity']['type']['T'][] = []

        const { label_entity_id, label_comp_id } = format.data.atom_site;
        for (let i = 0 as ElementIndex, il = format.data.atom_site._rowCount; i < il; i++) {
            const entityId = label_entity_id.value(i);
            if (!entityIds.has(entityId)) {
                ids.push(entityId)
                types.push(getEntityType(label_comp_id.value(i)))
                entityIds.add(entityId)
            }
        }

        const { entity_id: sphere_entity_id } = format.data.ihm_sphere_obj_site;
        for (let i = 0 as ElementIndex, il = format.data.ihm_sphere_obj_site._rowCount; i < il; i++) {
            const entityId = sphere_entity_id.value(i);
            if (!entityIds.has(entityId)) {
                ids.push(entityId)
                types.push('polymer')
                entityIds.add(entityId)
            }
        }

        const { entity_id: gaussian_entity_id } = format.data.ihm_gaussian_obj_site;
        for (let i = 0 as ElementIndex, il = format.data.ihm_gaussian_obj_site._rowCount; i < il; i++) {
            const entityId = gaussian_entity_id.value(i);
            if (!entityIds.has(entityId)) {
                ids.push(entityId)
                types.push('polymer')
                entityIds.add(entityId)
            }
        }

        entityData = Table.ofColumns(mmCIF_Schema.entity, {
            ...format.data.entity,
            id: Column.ofArray({ array: ids, schema: mmCIF_Schema.entity.id }),
            type: Column.ofArray({ array: types, schema: mmCIF_Schema.entity.type }),
        })
    } else {
        entityData = format.data.entity;
    }

    const getEntityIndex = Column.createIndexer<string, EntityIndex>(entityData.id)

    //

    const subtypes: EntitySubtype[] = new Array(entityData._rowCount)
    subtypes.fill('other')

    const entityIds = new Set<string>()
    let assignSubtype = false

    if (format.data.entity_poly.entity_id.isDefined) {
        const { entity_id, type, _rowCount } = format.data.entity_poly
        for (let i = 0; i < _rowCount; ++i) {
            const entityId = entity_id.value(i)
            subtypes[getEntityIndex(entityId)] = type.value(i)
            entityIds.add(entityId)
        }
    } else {
        assignSubtype = true
    }

    if (format.data.pdbx_entity_branch.entity_id.isDefined) {
        const { entity_id, type, _rowCount } = format.data.pdbx_entity_branch
        for (let i = 0; i < _rowCount; ++i) {
            const entityId = entity_id.value(i)
            subtypes[getEntityIndex(entityId)] = type.value(i)
            entityIds.add(entityId)
        }
    } else {
        assignSubtype = true
    }

    if (assignSubtype) {
        const chemCompType = new Map<string, string>()
        const { id, type } = format.data.chem_comp;
        for (let i = 0, il = format.data.chem_comp._rowCount; i < il; i++) {
            chemCompType.set(id.value(i), type.value(i))
        }

        const { label_entity_id, label_comp_id } = format.data.atom_site;
        for (let i = 0 as ElementIndex, il = format.data.atom_site._rowCount; i < il; i++) {
            const entityId = label_entity_id.value(i);
            if (!entityIds.has(entityId)) {
                const compId = label_comp_id.value(i)
                const compType = chemCompType.get(compId) || ''
                subtypes[getEntityIndex(entityId)] = getEntitySubtype(compId, compType)
                entityIds.add(entityId)
            }
        }
        // TODO how to handle coarse?
    }

    const subtypeColumn = Column.ofArray({ array: subtypes, schema: EntitySubtype })

    //

    return { data: entityData, subtype: subtypeColumn, getEntityIndex };
}

async function readStandard(ctx: RuntimeContext, format: mmCIF_Format, formatData: FormatData) {
    const atomCount = format.data.atom_site._rowCount;
    const entities = getEntities(format)

    const models: Model[] = [];
    let modelStart = 0;
    while (modelStart < atomCount) {
        const modelEnd = findModelEnd(format.data.atom_site.pdbx_PDB_model_num, modelStart);
        const { atom_site, sourceIndex } = await sortAtomSite(ctx, format.data.atom_site, modelStart, modelEnd);
        const model = createStandardModel(format, atom_site, sourceIndex, entities, formatData, models.length > 0 ? models[models.length - 1] : void 0);
        attachProps(model);
        models.push(model);
        modelStart = modelEnd;
    }
    return models;
}

function splitTable<T extends Table<any>>(table: T, col: Column<number>) {
    const ret = new Map<number, { table: T, start: number, end: number }>()
    const rowCount = table._rowCount;
    let modelStart = 0;
    while (modelStart < rowCount) {
        const modelEnd = findModelEnd(col, modelStart);
        const id = col.value(modelStart);
        ret.set(id, {
            table: Table.window(table, table._schema, modelStart, modelEnd) as T,
            start: modelStart,
            end: modelEnd
        });
        modelStart = modelEnd;
    }
    return ret;
}

function getModelGroupName(model_id: number, format: mmCIF_Format) {
    const { ihm_model_group, ihm_model_group_link } = format.data;

    const link = Table.pickRow(ihm_model_group_link, i => ihm_model_group_link.model_id.value(i) === model_id)
    if (link) {
        const group = Table.pickRow(ihm_model_group, i => ihm_model_group.id.value(i) === link.group_id)
        if (group) return group.name
    }
    return ''
}

async function readIHM(ctx: RuntimeContext, format: mmCIF_Format, formatData: FormatData) {
    // when `atom_site.ihm_model_id` is undefined fall back to `atom_site.pdbx_PDB_model_num`
    const atom_sites_modelColumn = format.data.atom_site.ihm_model_id.isDefined ? format.data.atom_site.ihm_model_id : format.data.atom_site.pdbx_PDB_model_num

    const { ihm_model_list } = format.data;
    const entities = getEntities(format)

    const atom_sites = splitTable(format.data.atom_site, atom_sites_modelColumn);
    // TODO: will coarse IHM records require sorting or will we trust it?
    // ==> Probably implement a sort as as well and store the sourceIndex same as with atomSite
    // If the sorting is implemented, updated mol-model/structure/properties: atom.sourceIndex
    const sphere_sites = splitTable(format.data.ihm_sphere_obj_site, format.data.ihm_sphere_obj_site.model_id);
    const gauss_sites = splitTable(format.data.ihm_gaussian_obj_site, format.data.ihm_gaussian_obj_site.model_id);

    const models: Model[] = [];

    const { model_id, model_name } = ihm_model_list;
    for (let i = 0; i < ihm_model_list._rowCount; i++) {
        const id = model_id.value(i);

        let atom_site, atom_site_sourceIndex;
        if (atom_sites.has(id)) {
            const e = atom_sites.get(id)!;
            // need to sort `format.data.atom_site` as `e.start` and `e.end` are indices into that
            const { atom_site: sorted, sourceIndex } = await sortAtomSite(ctx, format.data.atom_site, e.start, e.end);
            atom_site = sorted;
            atom_site_sourceIndex = sourceIndex;
        } else {
            atom_site = Table.window(format.data.atom_site, format.data.atom_site._schema, 0, 0);
            atom_site_sourceIndex = Column.ofIntArray([]);
        }

        const data: IHMData = {
            model_id: id,
            model_name: model_name.value(i),
            model_group_name: getModelGroupName(id, format),
            entities: entities,
            atom_site,
            atom_site_sourceIndex,
            ihm_sphere_obj_site: sphere_sites.has(id) ? sphere_sites.get(id)!.table : Table.window(format.data.ihm_sphere_obj_site, format.data.ihm_sphere_obj_site._schema, 0, 0),
            ihm_gaussian_obj_site: gauss_sites.has(id) ? gauss_sites.get(id)!.table : Table.window(format.data.ihm_gaussian_obj_site, format.data.ihm_gaussian_obj_site._schema, 0, 0)
        };
        const model = createModelIHM(format, data, formatData);
        attachProps(model);
        models.push(model);
    }

    return models;
}