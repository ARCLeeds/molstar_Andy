/**
 * Copyright (c) 2018 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

import { Unit, StructureElement, Structure } from '../../../../mol-model/structure';
import { Loci, EmptyLoci } from '../../../../mol-model/loci';
import { OrderedSet, Interval } from '../../../../mol-data/int';
import { LocationIterator } from '../../../../mol-geo/util/location-iterator';
import { PickingId } from '../../../../mol-geo/geometry/picking';
import { StructureGroup } from '../../../../mol-repr/structure/units-visual';
import { getResidueLoci } from './common';

export namespace NucleotideLocationIterator {
    export function fromGroup(group: Unit.SymmetryGroup): LocationIterator {
        const u = group.units[0]
        const nucleotideElementIndices = Unit.isAtomic(u) ? u.nucleotideElements : []
        const groupCount = nucleotideElementIndices.length
        const instanceCount = group.units.length
        const location = StructureElement.Location.create()
        const getLocation = (groupIndex: number, instanceIndex: number) => {
            const unit = group.units[instanceIndex]
            location.unit = unit
            location.element = nucleotideElementIndices[groupIndex]
            return location
        }
        return LocationIterator(groupCount, instanceCount, getLocation)
    }
}

export function getNucleotideElementLoci(pickingId: PickingId, structureGroup: StructureGroup, id: number) {
    const { objectId, instanceId, groupId } = pickingId
    if (id === objectId) {
        const { structure, group } = structureGroup
        const unit = group.units[instanceId]
        if (Unit.isAtomic(unit)) {
            return getResidueLoci(structure, unit, unit.nucleotideElements[groupId])
        }
    }
    return EmptyLoci
}

/**
 * Mark a nucleotide element (e.g. part of a cartoon block)
 * - mark only when all its residue's elements are in a loci
 */
export function eachNucleotideElement(loci: Loci, structureGroup: StructureGroup, apply: (interval: Interval) => boolean) {
    let changed = false
    if (!StructureElement.Loci.is(loci)) return false
    const { structure, group } = structureGroup
    if (!Structure.areEquivalent(loci.structure, structure)) return false
    const unit = group.units[0]
    if (!Unit.isAtomic(unit)) return false
    const { nucleotideElements, model, elements } = unit
    const { index, offsets } = model.atomicHierarchy.residueAtomSegments
    const { traceElementIndex } = model.atomicHierarchy.derived.residue
    const groupCount = nucleotideElements.length
    for (const e of loci.elements) {
        const unitIdx = group.unitIndexMap.get(e.unit.id)
        const eUnit = e.unit
        if (unitIdx !== undefined && Unit.isAtomic(eUnit)) {
            // TODO optimized implementation for intervals covering only part of the unit
            if (Interval.is(e.indices) && Interval.start(e.indices) === 0 && Interval.end(e.indices) === e.unit.elements.length) {
                const start = unitIdx * groupCount;
                const end = unitIdx * groupCount + groupCount;
                if (apply(Interval.ofBounds(start, end))) changed = true
            } else {
                OrderedSet.forEach(e.indices, v => {
                    const rI = index[elements[v]]
                    const unitIndexMin = OrderedSet.findPredecessorIndex(elements, offsets[rI])
                    const unitIndexMax = OrderedSet.findPredecessorIndex(elements, offsets[rI + 1] - 1)
                    const unitIndexInterval = Interval.ofRange(unitIndexMin, unitIndexMax)
                    if (!OrderedSet.areIntersecting(e.indices, unitIndexInterval)) return
                    const eI = traceElementIndex[rI]
                    const idx = OrderedSet.indexOf(eUnit.nucleotideElements, eI)
                    if (idx !== -1) {
                        if (apply(Interval.ofSingleton(unitIdx * groupCount + idx))) changed = true
                    }
                })
            }
        }
    }
    return changed
}