/**
 * Copyright (c) 2019-2020 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author David Sehnal <david.sehnal@gmail.com>
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

import { Structure, StructureElement, Bond } from '../../../../mol-model/structure';
import { PluginBehavior } from '../../../../mol-plugin/behavior';
import { PluginCommands } from '../../../../mol-plugin/command';
import { PluginStateObject } from '../../../../mol-plugin/state/objects';
import { StateTransforms } from '../../../../mol-plugin/state/transforms';
import { StructureRepresentation3DHelpers } from '../../../../mol-plugin/state/transforms/representation';
import { BuiltInStructureRepresentations } from '../../../../mol-repr/structure/registry';
import { MolScriptBuilder as MS } from '../../../../mol-script/language/builder';
import { StateObjectCell, StateSelection, StateTransform } from '../../../../mol-state';
import { BuiltInColorThemes } from '../../../../mol-theme/color';
import { BuiltInSizeThemes } from '../../../../mol-theme/size';
import { ButtonsType, ModifiersKeys } from '../../../../mol-util/input/input-observer';
import { Binding } from '../../../../mol-util/binding';
import { ParamDefinition as PD } from '../../../../mol-util/param-definition';
import { isEmptyLoci, Loci, EmptyLoci } from '../../../../mol-model/loci';
import { InteractionsRepresentationProvider } from '../../../../mol-model-props/computed/representations/interactions';
import { InteractionTypeColorThemeProvider } from '../../../../mol-model-props/computed/themes/interaction-type';

const B = ButtonsType
const M = ModifiersKeys
const Trigger = Binding.Trigger

const DefaultStructureRepresentationInteractionBindings = {
    clickInteractionAroundOnly: Binding([Trigger(B.Flag.Secondary, M.create()), Trigger(B.Flag.Primary, M.create({ control: true }))], 'Show the structure interaction around only the clicked element using ${triggers}.'),
}
const StructureRepresentationInteractionParams = {
    bindings: PD.Value(DefaultStructureRepresentationInteractionBindings, { isHidden: true }),
}
type StructureRepresentationInteractionProps = PD.Values<typeof StructureRepresentationInteractionParams>

enum Tags {
    Group = 'structure-interaction-group',
    ResidueSel = 'structure-interaction-residue-sel',
    ResidueRepr = 'structure-interaction-residue-repr',
    SurrSel = 'structure-interaction-surr-sel',
    SurrRepr = 'structure-interaction-surr-repr',
    SurrNciRepr = 'structure-interaction-surr-nci-repr'
}

const TagSet: Set<Tags> = new Set([Tags.Group, Tags.ResidueSel, Tags.ResidueRepr, Tags.SurrSel, Tags.SurrRepr, Tags.SurrNciRepr])

export class StructureRepresentationInteractionBehavior extends PluginBehavior.WithSubscribers<StructureRepresentationInteractionProps> {

    private createResVisualParams(s: Structure) {
        return StructureRepresentation3DHelpers.createParams(this.plugin, s, {
            repr: [BuiltInStructureRepresentations['ball-and-stick'], () => ({ })],
            size: [BuiltInSizeThemes.uniform, () => ({ })]
        });
    }

    private createSurVisualParams(s: Structure) {
        return StructureRepresentation3DHelpers.createParams(this.plugin, s, {
            repr: [BuiltInStructureRepresentations['ball-and-stick'], () => ({ })],
            color: [BuiltInColorThemes['element-symbol'], () => ({ })],
            size: [BuiltInSizeThemes.uniform, () => ({ })]
        });
    }

    private createSurNciVisualParams(s: Structure) {
        return StructureRepresentation3DHelpers.createParams(this.plugin, s, {
            repr: [InteractionsRepresentationProvider, () => ({ })],
            color: [InteractionTypeColorThemeProvider, () => ({ })],
            size: [BuiltInSizeThemes.uniform, () => ({ })]
        });
    }

    private ensureShape(cell: StateObjectCell<PluginStateObject.Molecule.Structure>) {
        const state = this.plugin.state.dataState, tree = state.tree;
        const builder = state.build();
        const refs = StateSelection.findUniqueTagsInSubtree(tree, cell.transform.ref, TagSet);

        if (!refs['structure-interaction-group']) {
            refs['structure-interaction-group'] = builder.to(cell).group(StateTransforms.Misc.CreateGroup,
                { label: 'Current Interaction' }, { tags: Tags.Group }).ref;
        }

        // Selections
        if (!refs[Tags.ResidueSel]) {
            refs[Tags.ResidueSel] = builder.to(refs['structure-interaction-group']).apply(StateTransforms.Model.StructureSelectionFromBundle,
                { bundle: { } as any, label: 'Residue' }, { tags: Tags.ResidueSel }).ref;
        }

        if (!refs[Tags.SurrSel]) {
            refs[Tags.SurrSel] = builder.to(refs['structure-interaction-group']).apply(StateTransforms.Model.StructureSelectionFromExpression,
                { expression: { } as any, label: 'Surroundings' }, { tags: Tags.SurrSel }).ref;
        }

        // Representations
        // TODO: ability to customize how it looks in the behavior params
        if (!refs[Tags.ResidueRepr]) {
            refs[Tags.ResidueRepr] = builder.to(refs['structure-interaction-residue-sel']!).apply(StateTransforms.Representation.StructureRepresentation3D,
                this.createResVisualParams(cell.obj!.data), { tags: Tags.ResidueRepr }).ref;
        }

        if (!refs[Tags.SurrRepr]) {
            refs[Tags.SurrRepr] = builder.to(refs['structure-interaction-surr-sel']!).apply(StateTransforms.Representation.StructureRepresentation3D,
                this.createSurVisualParams(cell.obj!.data), { tags: Tags.SurrRepr }).ref;
        }

        if (!refs[Tags.SurrNciRepr]) {
            refs[Tags.SurrNciRepr] = builder.to(refs['structure-interaction-surr-sel']!).apply(StateTransforms.Representation.StructureRepresentation3D,
                this.createSurNciVisualParams(cell.obj!.data), { tags: Tags.SurrNciRepr }).ref;
        }

        return { state, builder, refs };
    }

    private clear(root: StateTransform.Ref) {
        const state = this.plugin.state.dataState;
        const groups = state.select(StateSelection.Generators.byRef(root).subtree().withTag(Tags.Group));
        if (groups.length === 0) return;

        const update = state.build();
        const bundle = StructureElement.Bundle.Empty;
        const expression = MS.struct.generator.empty();
        for (const g of groups) {
            // TODO: update props of the group node to ghost

            const res = StateSelection.findTagInSubtree(state.tree, g.transform.ref, Tags.ResidueSel);
            const surr = StateSelection.findTagInSubtree(state.tree, g.transform.ref, Tags.SurrSel);
            if (res) update.to(res).update(StateTransforms.Model.StructureSelectionFromBundle, old => ({ ...old, bundle }));
            if (surr) update.to(surr).update(StateTransforms.Model.StructureSelectionFromExpression, old => ({ ...old, expression }));
        }

        PluginCommands.State.Update.dispatch(this.plugin, { state, tree: update, options: { doNotLogTiming: true, doNotUpdateCurrent: true } });
    }

    register(ref: string): void {
        let lastLoci: Loci = EmptyLoci;

        this.subscribeObservable(this.plugin.events.state.object.removed, o => {
            if (!PluginStateObject.Molecule.Structure.is(o.obj) || !StructureElement.Loci.is(lastLoci)) return;
            if (lastLoci.structure === o.obj.data) {
                lastLoci = EmptyLoci;
            }
        });

        this.subscribeObservable(this.plugin.events.state.object.updated, o => {
            if (!PluginStateObject.Molecule.Structure.is(o.oldObj) || !StructureElement.Loci.is(lastLoci)) return;
            if (lastLoci.structure === o.oldObj.data) {
                lastLoci = EmptyLoci;
            }
        });

        this.subscribeObservable(this.plugin.behaviors.interaction.click, ({ current, button, modifiers }) => {
            const { clickInteractionAroundOnly } = this.params.bindings

            if (Binding.match(clickInteractionAroundOnly, button, modifiers)) {
                if (isEmptyLoci(current.loci)) {
                    this.clear(StateTransform.RootRef);
                    lastLoci = current.loci;
                    return;
                }

                let loci: StructureElement.Loci;
                if (StructureElement.Loci.is(current.loci)) {
                    loci = current.loci;
                } else if (Bond.isLoci(current.loci)) {
                    loci = Bond.toStructureElementLoci(current.loci);
                } else if (Structure.isLoci(current.loci)) {
                    loci = Structure.toStructureElementLoci(current.loci.structure);
                } else {
                    return;
                }

                if (StructureElement.Loci.isEmpty(loci)) return;

                const parent = this.plugin.helpers.substructureParent.get(loci.structure);
                if (!parent || !parent.obj) return;

                if (Loci.areEqual(lastLoci, loci)) {
                    lastLoci = EmptyLoci;
                    this.clear(parent.transform.ref);
                    return;
                }

                lastLoci = loci;

                const residueLoci = StructureElement.Loci.extendToWholeResidues(StructureElement.Loci.remap(loci, parent.obj!.data))
                const residueBundle = StructureElement.Bundle.fromLoci(residueLoci)

                const surroundings = MS.struct.modifier.includeSurroundings({
                    0: StructureElement.Bundle.toExpression(residueBundle),
                    radius: 5,
                    'as-whole-residues': true
                });

                const { state, builder, refs } = this.ensureShape(parent);

                builder.to(refs[Tags.ResidueSel]!).update(StateTransforms.Model.StructureSelectionFromBundle, old => ({ ...old, bundle: residueBundle }));
                builder.to(refs[Tags.SurrSel]!).update(StateTransforms.Model.StructureSelectionFromExpression, old => ({ ...old, expression: surroundings }));

                PluginCommands.State.Update.dispatch(this.plugin, { state, tree: builder, options: { doNotLogTiming: true, doNotUpdateCurrent: true } });
            }
        });
    }

    async update(params: StructureRepresentationInteractionProps) {
        return false;
    }
}

export const StructureRepresentationInteraction = PluginBehavior.create({
    name: 'create-structure-representation-interaction',
    display: { name: 'Structure Representation Interaction' },
    category: 'interaction',
    ctor: StructureRepresentationInteractionBehavior,
    params: () => StructureRepresentationInteractionParams
});