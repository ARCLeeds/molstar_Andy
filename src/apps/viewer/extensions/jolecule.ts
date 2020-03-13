// /**
//  * Copyright (c) 2019 mol* contributors, licensed under MIT, See LICENSE file for more info.
//  *
//  * @author David Sehnal <david.sehnal@gmail.com>
//  */

// import { StateTree, StateBuilder, StateAction, State } from '../../../mol-state';
// import { StateTransforms } from '../../../mol-plugin/state/transforms';
// import { createModelTree } from '../../../mol-plugin/state/actions/structure';
// import { PluginContext } from '../../../mol-plugin/context';
// import { PluginStateObject } from '../../../mol-plugin/state/objects';
// import { ParamDefinition } from '../../../mol-util/param-definition';
// import { PluginCommands } from '../../../mol-plugin/command';
// import { Vec3 } from '../../../mol-math/linear-algebra';
// import { PluginStateSnapshotManager } from '../../../mol-plugin/state/snapshots';
// import { MolScriptBuilder as MS } from '../../../mol-script/language/builder';
// import { Text } from '../../../mol-geo/geometry/text/text';
// import { UUID } from '../../../mol-util';
// import { ColorNames } from '../../../mol-util/color/names';
// import { Camera } from '../../../mol-canvas3d/camera';
// import { createStructureRepresentation3dParamss } from '../../../mol-plugin/state/transforms/representation';
// import { createDefaultStructureComplex } from '../../../mol-plugin/util/structure-complex-helper';

// export const CreateJoleculeState = StateAction.build({
//     display: { name: 'Jolecule State Import' },
//     params: { id: ParamDefinition.Text('1mbo') },
//     from: PluginStateObject.Root
// })(async ({ ref, state, params }, plugin: PluginContext) => {
//     try {
//         const id = params.id.trim().toLowerCase();
//         const data = await plugin.runTask(plugin.fetch({ url: `https://jolecule.appspot.com/pdb/${id}.views.json`, type: 'json' })) as JoleculeSnapshot[];

//         data.sort((a, b) => a.order - b.order);

//         await PluginCommands.State.RemoveObject.dispatch(plugin, { state, ref });
//         plugin.state.snapshots.clear();

//         const template = createTemplate(plugin, state, id);
//         const snapshots = data.map((e, idx) => buildSnapshot(plugin, template, { e, idx, len: data.length }));
//         for (const s of snapshots) {
//             plugin.state.snapshots.add(s);
//         }

//         PluginCommands.State.Snapshots.Apply.dispatch(plugin, { id: snapshots[0].snapshot.id });
//     } catch (e) {
//         plugin.log.error(`Jolecule Failed: ${e}`);
//     }
// });

// interface JoleculeSnapshot {
//     order: number,
//     distances: { i_atom1: number, i_atom2: number }[],
//     labels: { i_atom: number, text: string }[],
//     camera: { up: Vec3, pos: Vec3, in: Vec3, slab: { z_front: number, z_back: number, zoom: number } },
//     selected: number[],
//     text: string
// }

// function createTemplate(plugin: PluginContext, state: State, id: string) {
//     const b = new StateBuilder.Root(state.tree);
//     const data = b.toRoot().apply(StateTransforms.Data.Download, { url: `https://www.ebi.ac.uk/pdbe/static/entry/${id}_updated.cif` }, { state: { isGhost: true }});
//     const model = createModelTree(data, 'cif');
//     const structure = model.apply(StateTransforms.Model.StructureFromModel);
//     createDefaultStructureComplex(plugin, structure);
//     return { tree: b.getTree(), structure: structure.ref };
// }

// const labelOptions: ParamDefinition.Values<Text.Params> = {
//     ...ParamDefinition.getDefaultValues(Text.Params),
//     tether: true,
//     sizeFactor: 1.3,
//     attachment: 'bottom-right',
//     offsetZ: 10,
//     background: true,
//     backgroundMargin: 0.2,
//     backgroundColor: ColorNames.skyblue,
//     backgroundOpacity: 0.9
// }

// // const distanceLabelOptions = {
// //     ...ParamDefinition.getDefaultValues(Text.Params),
// //     sizeFactor: 1,
// //     offsetX: 0,
// //     offsetY: 0,
// //     offsetZ: 10,
// //     background: true,
// //     backgroundMargin: 0.2,
// //     backgroundColor: ColorNames.snow,
// //     backgroundOpacity: 0.9
// // }

// function buildSnapshot(plugin: PluginContext, template: { tree: StateTree, structure: string }, params: { e: JoleculeSnapshot, idx: number, len: number }): PluginStateSnapshotManager.Entry {
//     const b = new StateBuilder.Root(template.tree);

//     let i = 0;
//     for (const l of params.e.labels) {
//         const expression = createExpression([l.i_atom]);
//         const group = b.to(template.structure)
//             .group(StateTransforms.Misc.CreateGroup, { label: `Label ${++i}` });

//         group
//             .apply(StateTransforms.Model.StructureSelectionFromExpression, { expression, label: 'Atom' })
//             .apply(StateTransforms.Representation.StructureLabels3D, {
//                 target: { name: 'static-text', params: { value: l.text || '' } },
//                 options: labelOptions
//             });

//         group
//             .apply(StateTransforms.Model.StructureSelectionFromExpression, { expression: MS.struct.modifier.wholeResidues([ expression ]), label: 'Residue' })
//             .apply(StateTransforms.Representation.StructureRepresentation3D,
//                 createStructureRepresentation3dParamss.getDefaultParamsStatic(plugin, 'ball-and-stick', {  }));
//     }
//     if (params.e.selected && params.e.selected.length > 0) {
//         b.to(template.structure)
//             .apply(StateTransforms.Model.StructureSelectionFromExpression, { expression: createExpression(params.e.selected), label: `Selected` })
//             .apply(StateTransforms.Representation.StructureRepresentation3D,
//                 createStructureRepresentation3dParamss.getDefaultParamsStatic(plugin, 'ball-and-stick'));
//     }
//     // TODO
//     // for (const l of params.e.distances) {
//     //     b.to('structure')
//     //         .apply(StateTransforms.Model.StructureSelectionFromExpression, { query: createQuery([l.i_atom1, l.i_atom2]), label: `Distance ${++i}` })
//     //         .apply(StateTransforms.Representation.StructureLabels3D, {
//     //             target: { name: 'static-text', params: { value: l. || '' } },
//     //             options: labelOptions
//     //         });
//     // }
//     return PluginStateSnapshotManager.Entry({
//         id: UUID.create22(),
//         data: { tree: StateTree.toJSON(b.getTree()) },
//         camera: {
//             current: getCameraSnapshot(params.e.camera),
//             transitionStyle: 'animate',
//             transitionDurationInMs: 350
//         }
//     }, {
//         name:  params.e.text
//     });
// }

// function getCameraSnapshot(e: JoleculeSnapshot['camera']): Camera.Snapshot {
//     const direction = Vec3.sub(Vec3(), e.pos, e.in);
//     Vec3.normalize(direction, direction);
//     const up = Vec3.sub(Vec3(), e.pos, e.up);
//     Vec3.normalize(up, up);

//     const s: Camera.Snapshot = {
//         mode: 'perspective',
//         fov: Math.PI / 4,
//         position: Vec3.scaleAndAdd(Vec3(), e.pos, direction, e.slab.zoom),
//         target: e.pos,
//         radius: (e.slab.z_back - e.slab.z_front) / 2,
//         fog: 50,
//         up,
//     };
//     return s;
// }

// function createExpression(atomIndices: number[]) {
//     if (atomIndices.length === 0) return MS.struct.generator.empty();

//     return MS.struct.generator.atomGroups({
//         'atom-test': atomIndices.length === 1
//             ? MS.core.rel.eq([MS.struct.atomProperty.core.sourceIndex(), atomIndices[0]])
//             : MS.core.set.has([MS.set.apply(null, atomIndices), MS.struct.atomProperty.core.sourceIndex()]),
//         'group-by': 0
//     });
// }