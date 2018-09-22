/**
 * Copyright (c) 2018 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

// TODO refactor to make DRY

import { Unit, Structure } from 'mol-model/structure';
import { RepresentationProps, Visual } from '../';
import { DefaultStructureMeshProps, VisualUpdateState, DefaultStructurePointsProps, DefaultStructureLinesProps } from '.';
import { RuntimeContext } from 'mol-task';
import { PickingId } from '../../geometry/picking';
import { LocationIterator } from '../../util/location-iterator';
import { Mesh } from '../../geometry/mesh/mesh';
import { MarkerAction, applyMarkerAction, createMarkers } from '../../geometry/marker-data';
import { Loci, isEveryLoci, EmptyLoci } from 'mol-model/loci';
import { MeshRenderObject, PointsRenderObject, LinesRenderObject } from 'mol-gl/render-object';
import { createUnitsMeshRenderObject, createUnitsPointsRenderObject, createUnitsTransform, createUnitsLinesRenderObject } from './visual/util/common';
import { deepEqual, ValueCell, UUID } from 'mol-util';
import { Interval } from 'mol-data/int';
import { Points } from '../../geometry/points/points';
import { updateRenderableState } from '../../geometry/geometry';
import { createColors } from '../../geometry/color-data';
import { createSizes } from '../../geometry/size-data';
import { Lines } from '../../geometry/lines/lines';

export type StructureGroup = { structure: Structure, group: Unit.SymmetryGroup }

export interface UnitsVisual<P extends RepresentationProps = {}> extends Visual<StructureGroup, P> { }

function sameGroupConformation(groupA: Unit.SymmetryGroup, groupB: Unit.SymmetryGroup) {
    return (
        groupA.units.length === groupB.units.length &&
        Unit.conformationId(groupA.units[0]) === Unit.conformationId(groupB.units[0])
    )
}

// mesh

export const DefaultUnitsMeshProps = {
    ...DefaultStructureMeshProps,
    unitKinds: [ Unit.Kind.Atomic, Unit.Kind.Spheres ] as Unit.Kind[]
}
export type UnitsMeshProps = typeof DefaultUnitsMeshProps

export interface UnitsMeshVisualBuilder<P extends UnitsMeshProps> {
    defaultProps: P
    createMesh(ctx: RuntimeContext, unit: Unit, structure: Structure, props: P, mesh?: Mesh): Promise<Mesh>
    createLocationIterator(group: Unit.SymmetryGroup): LocationIterator
    getLoci(pickingId: PickingId, group: Unit.SymmetryGroup, id: number): Loci
    mark(loci: Loci, group: Unit.SymmetryGroup, apply: (interval: Interval) => boolean): boolean
    setUpdateState(state: VisualUpdateState, newProps: P, currentProps: P): void
}

export function UnitsMeshVisual<P extends UnitsMeshProps>(builder: UnitsMeshVisualBuilder<P>): UnitsVisual<P> {
    const { defaultProps, createMesh, createLocationIterator, getLoci, mark, setUpdateState } = builder
    const updateState = VisualUpdateState.create()

    let renderObject: MeshRenderObject | undefined
    let currentProps: P
    let mesh: Mesh
    let currentGroup: Unit.SymmetryGroup
    let currentStructure: Structure
    let locationIt: LocationIterator
    let currentConformationId: UUID

    async function create(ctx: RuntimeContext, group: Unit.SymmetryGroup, props: Partial<P> = {}) {
        currentProps = Object.assign({}, defaultProps, props)
        currentProps.colorTheme.structure = currentStructure
        currentGroup = group

        const unit = group.units[0]
        currentConformationId = Unit.conformationId(unit)
        mesh = currentProps.unitKinds.includes(unit.kind)
            ? await createMesh(ctx, unit, currentStructure, currentProps, mesh)
            : Mesh.createEmpty(mesh)

        // TODO create empty location iterator when not in unitKinds
        locationIt = createLocationIterator(group)
        renderObject = await createUnitsMeshRenderObject(ctx, group, mesh, locationIt, currentProps)
    }

    async function update(ctx: RuntimeContext, props: Partial<P> = {}) {
        if (!renderObject) return

        const newProps = Object.assign({}, currentProps, props)
        newProps.colorTheme.structure = currentStructure
        const unit = currentGroup.units[0]

        locationIt.reset()
        VisualUpdateState.reset(updateState)
        setUpdateState(updateState, newProps, currentProps)

        const newConformationId = Unit.conformationId(unit)
        if (newConformationId !== currentConformationId) {
            currentConformationId = newConformationId
            updateState.createGeometry = true
        }

        if (currentGroup.units.length !== locationIt.instanceCount) updateState.updateTransform = true

        if (!deepEqual(newProps.sizeTheme, currentProps.sizeTheme)) updateState.createGeometry = true
        if (!deepEqual(newProps.colorTheme, currentProps.colorTheme)) updateState.updateColor = true
        if (!deepEqual(newProps.unitKinds, currentProps.unitKinds)) updateState.createGeometry = true

        //

        if (updateState.updateTransform) {
            locationIt = createLocationIterator(currentGroup)
            const { instanceCount, groupCount } = locationIt
            createUnitsTransform(currentGroup, renderObject.values)
            createMarkers(instanceCount * groupCount, renderObject.values)
            updateState.updateColor = true
        }

        if (updateState.createGeometry) {
            mesh = newProps.unitKinds.includes(unit.kind)
                ? await createMesh(ctx, unit, currentStructure, newProps, mesh)
                : Mesh.createEmpty(mesh)
            ValueCell.update(renderObject.values.drawCount, mesh.triangleCount * 3)
            updateState.updateColor = true
        }

        if (updateState.updateColor) {
            await createColors(ctx, locationIt, newProps.colorTheme, renderObject.values)
        }

        // TODO why do I need to cast here?
        Mesh.updateValues(renderObject.values, newProps as UnitsMeshProps)
        updateRenderableState(renderObject.state, newProps as UnitsMeshProps)

        currentProps = newProps
    }

    return {
        get renderObject () { return renderObject },
        async createOrUpdate(ctx: RuntimeContext, props: Partial<P> = {}, structureGroup?: StructureGroup) {
            if (structureGroup) currentStructure = structureGroup.structure
            const group = structureGroup ? structureGroup.group : undefined
            if (!group && !currentGroup) {
                throw new Error('missing group')
            } else if (group && (!currentGroup || !renderObject)) {
                // console.log('unit-visual first create')
                await create(ctx, group, props)
            } else if (group && group.hashCode !== currentGroup.hashCode) {
                // console.log('unit-visual group.hashCode !== currentGroup.hashCode')
                await create(ctx, group, props)
            } else {
                // console.log('unit-visual update')
                if (group && !sameGroupConformation(group, currentGroup)) {
                    // console.log('unit-visual new conformation')
                    currentGroup = group
                }
                await update(ctx, props)
            }
        },
        getLoci(pickingId: PickingId) {
            return renderObject ? getLoci(pickingId, currentGroup, renderObject.id) : EmptyLoci
        },
        mark(loci: Loci, action: MarkerAction) {
            if (!renderObject) return false
            const { tMarker } = renderObject.values
            const { groupCount, instanceCount } = locationIt

            function apply(interval: Interval) {
                const start = Interval.start(interval)
                const end = Interval.end(interval)
                return applyMarkerAction(tMarker.ref.value.array, start, end, action)
            }

            let changed = false
            if (isEveryLoci(loci)) {
                changed = apply(Interval.ofBounds(0, groupCount * instanceCount))
            } else {
                changed = mark(loci, currentGroup, apply)
            }
            if (changed) {
                ValueCell.update(tMarker, tMarker.ref.value)
            }
            return changed
        },
        destroy() {
            // TODO
            renderObject = undefined
        }
    }
}

// points

export const DefaultUnitsPointsProps = {
    ...DefaultStructurePointsProps,
    unitKinds: [ Unit.Kind.Atomic, Unit.Kind.Spheres ] as Unit.Kind[]
}
export type UnitsPointsProps = typeof DefaultUnitsPointsProps

export interface UnitsPointVisualBuilder<P extends UnitsPointsProps> {
    defaultProps: P
    createPoints(ctx: RuntimeContext, unit: Unit, structure: Structure, props: P, points?: Points): Promise<Points>
    createLocationIterator(group: Unit.SymmetryGroup): LocationIterator
    getLoci(pickingId: PickingId, group: Unit.SymmetryGroup, id: number): Loci
    mark(loci: Loci, group: Unit.SymmetryGroup, apply: (interval: Interval) => boolean): boolean
    setUpdateState(state: VisualUpdateState, newProps: P, currentProps: P): void
}

export function UnitsPointsVisual<P extends UnitsPointsProps>(builder: UnitsPointVisualBuilder<P>): UnitsVisual<P> {
    const { defaultProps, createPoints, createLocationIterator, getLoci, mark, setUpdateState } = builder
    const updateState = VisualUpdateState.create()

    let renderObject: PointsRenderObject | undefined
    let currentProps: P
    let points: Points
    let currentGroup: Unit.SymmetryGroup
    let currentStructure: Structure
    let locationIt: LocationIterator
    let currentConformationId: UUID

    async function create(ctx: RuntimeContext, group: Unit.SymmetryGroup, props: Partial<P> = {}) {
        currentProps = Object.assign({}, defaultProps, props)
        currentProps.colorTheme.structure = currentStructure
        currentGroup = group

        const unit = group.units[0]
        currentConformationId = Unit.conformationId(unit)
        points = currentProps.unitKinds.includes(unit.kind)
            ? await createPoints(ctx, unit, currentStructure, currentProps, points)
            : Points.createEmpty(points)

        // TODO create empty location iterator when not in unitKinds
        locationIt = createLocationIterator(group)
        renderObject = await createUnitsPointsRenderObject(ctx, group, points, locationIt, currentProps)
    }

    async function update(ctx: RuntimeContext, props: Partial<P> = {}) {
        if (!renderObject) return

        const newProps = Object.assign({}, currentProps, props)
        newProps.colorTheme.structure = currentStructure
        const unit = currentGroup.units[0]

        locationIt.reset()
        VisualUpdateState.reset(updateState)
        setUpdateState(updateState, newProps, currentProps)

        const newConformationId = Unit.conformationId(unit)
        if (newConformationId !== currentConformationId) {
            currentConformationId = newConformationId
            updateState.createGeometry = true
        }

        if (currentGroup.units.length !== locationIt.instanceCount) updateState.updateTransform = true

        if (!deepEqual(newProps.sizeTheme, currentProps.sizeTheme)) updateState.updateSize = true
        if (!deepEqual(newProps.colorTheme, currentProps.colorTheme)) updateState.updateColor = true
        if (!deepEqual(newProps.unitKinds, currentProps.unitKinds)) updateState.createGeometry = true

        //

        if (updateState.updateTransform) {
            locationIt = createLocationIterator(currentGroup)
            const { instanceCount, groupCount } = locationIt
            createUnitsTransform(currentGroup, renderObject.values)
            createMarkers(instanceCount * groupCount, renderObject.values)
            updateState.updateColor = true
        }

        if (updateState.createGeometry) {
            points = newProps.unitKinds.includes(unit.kind)
                ? await createPoints(ctx, unit, currentStructure, newProps, points)
                : Points.createEmpty(points)
            ValueCell.update(renderObject.values.drawCount, points.pointCount)
            updateState.updateColor = true
        }

        if (updateState.updateSize) {
            await createSizes(ctx, locationIt, newProps.sizeTheme, renderObject.values)
        }

        if (updateState.updateColor) {
            await createColors(ctx, locationIt, newProps.colorTheme, renderObject.values)
        }

        // TODO why do I need to cast here?
        Points.updateValues(renderObject.values, newProps as UnitsPointsProps)
        updateRenderableState(renderObject.state, newProps as UnitsPointsProps)

        currentProps = newProps
    }

    return {
        get renderObject () { return renderObject },
        async createOrUpdate(ctx: RuntimeContext, props: Partial<P> = {}, structureGroup?: StructureGroup) {
            if (structureGroup) currentStructure = structureGroup.structure
            const group = structureGroup ? structureGroup.group : undefined
            if (!group && !currentGroup) {
                throw new Error('missing group')
            } else if (group && (!currentGroup || !renderObject)) {
                // console.log('unit-visual first create')
                await create(ctx, group, props)
            } else if (group && group.hashCode !== currentGroup.hashCode) {
                // console.log('unit-visual group.hashCode !== currentGroup.hashCode')
                await create(ctx, group, props)
            } else {
                // console.log('unit-visual update')
                if (group && !sameGroupConformation(group, currentGroup)) {
                    // console.log('unit-visual new conformation')
                    currentGroup = group
                }
                await update(ctx, props)
            }
        },
        getLoci(pickingId: PickingId) {
            return renderObject ? getLoci(pickingId, currentGroup, renderObject.id) : EmptyLoci
        },
        mark(loci: Loci, action: MarkerAction) {
            if (!renderObject) return false
            const { tMarker } = renderObject.values
            const { groupCount, instanceCount } = locationIt

            function apply(interval: Interval) {
                const start = Interval.start(interval)
                const end = Interval.end(interval)
                return applyMarkerAction(tMarker.ref.value.array, start, end, action)
            }

            let changed = false
            if (isEveryLoci(loci)) {
                changed = apply(Interval.ofBounds(0, groupCount * instanceCount))
            } else {
                changed = mark(loci, currentGroup, apply)
            }
            if (changed) {
                ValueCell.update(tMarker, tMarker.ref.value)
            }
            return changed
        },
        destroy() {
            // TODO
            renderObject = undefined
        }
    }
}

// lines

export const DefaultUnitsLinesProps = {
    ...DefaultStructureLinesProps,
    unitKinds: [ Unit.Kind.Atomic, Unit.Kind.Spheres ] as Unit.Kind[]
}
export type UnitsLinesProps = typeof DefaultUnitsLinesProps

export interface UnitsLinesVisualBuilder<P extends UnitsLinesProps> {
    defaultProps: P
    createLines(ctx: RuntimeContext, unit: Unit, structure: Structure, props: P, lines?: Lines): Promise<Lines>
    createLocationIterator(group: Unit.SymmetryGroup): LocationIterator
    getLoci(pickingId: PickingId, group: Unit.SymmetryGroup, id: number): Loci
    mark(loci: Loci, group: Unit.SymmetryGroup, apply: (interval: Interval) => boolean): boolean
    setUpdateState(state: VisualUpdateState, newProps: P, currentProps: P): void
}

export function UnitsLinesVisual<P extends UnitsLinesProps>(builder: UnitsLinesVisualBuilder<P>): UnitsVisual<P> {
    const { defaultProps, createLines, createLocationIterator, getLoci, mark, setUpdateState } = builder
    const updateState = VisualUpdateState.create()

    let renderObject: LinesRenderObject | undefined
    let currentProps: P
    let lines: Lines
    let currentGroup: Unit.SymmetryGroup
    let currentStructure: Structure
    let locationIt: LocationIterator
    let currentConformationId: UUID

    async function create(ctx: RuntimeContext, group: Unit.SymmetryGroup, props: Partial<P> = {}) {
        currentProps = Object.assign({}, defaultProps, props)
        currentProps.colorTheme.structure = currentStructure
        currentGroup = group

        const unit = group.units[0]
        currentConformationId = Unit.conformationId(unit)
        lines = currentProps.unitKinds.includes(unit.kind)
            ? await createLines(ctx, unit, currentStructure, currentProps, lines)
            : Lines.createEmpty(lines)

        // TODO create empty location iterator when not in unitKinds
        locationIt = createLocationIterator(group)
        renderObject = await createUnitsLinesRenderObject(ctx, group, lines, locationIt, currentProps)
    }

    async function update(ctx: RuntimeContext, props: Partial<P> = {}) {
        if (!renderObject) return

        const newProps = Object.assign({}, currentProps, props)
        newProps.colorTheme.structure = currentStructure
        const unit = currentGroup.units[0]

        locationIt.reset()
        VisualUpdateState.reset(updateState)
        setUpdateState(updateState, newProps, currentProps)

        const newConformationId = Unit.conformationId(unit)
        if (newConformationId !== currentConformationId) {
            currentConformationId = newConformationId
            updateState.createGeometry = true
        }

        if (currentGroup.units.length !== locationIt.instanceCount) updateState.updateTransform = true

        if (!deepEqual(newProps.sizeTheme, currentProps.sizeTheme)) updateState.updateSize = true
        if (!deepEqual(newProps.colorTheme, currentProps.colorTheme)) updateState.updateColor = true
        if (!deepEqual(newProps.unitKinds, currentProps.unitKinds)) updateState.createGeometry = true

        //

        if (updateState.updateTransform) {
            locationIt = createLocationIterator(currentGroup)
            const { instanceCount, groupCount } = locationIt
            createUnitsTransform(currentGroup, renderObject.values)
            createMarkers(instanceCount * groupCount, renderObject.values)
            updateState.updateColor = true
        }

        if (updateState.createGeometry) {
            lines = newProps.unitKinds.includes(unit.kind)
                ? await createLines(ctx, unit, currentStructure, newProps, lines)
                : Lines.createEmpty(lines)
            ValueCell.update(renderObject.values.drawCount, lines.lineCount)
            updateState.updateColor = true
        }

        if (updateState.updateSize) {
            await createSizes(ctx, locationIt, newProps.sizeTheme, renderObject.values)
        }

        if (updateState.updateColor) {
            await createColors(ctx, locationIt, newProps.colorTheme, renderObject.values)
        }

        // TODO why do I need to cast here?
        Lines.updateValues(renderObject.values, newProps as UnitsLinesProps)
        updateRenderableState(renderObject.state, newProps as UnitsLinesProps)

        currentProps = newProps
    }

    return {
        get renderObject () { return renderObject },
        async createOrUpdate(ctx: RuntimeContext, props: Partial<P> = {}, structureGroup?: StructureGroup) {
            if (structureGroup) currentStructure = structureGroup.structure
            const group = structureGroup ? structureGroup.group : undefined
            if (!group && !currentGroup) {
                throw new Error('missing group')
            } else if (group && (!currentGroup || !renderObject)) {
                // console.log('unit-visual first create')
                await create(ctx, group, props)
            } else if (group && group.hashCode !== currentGroup.hashCode) {
                // console.log('unit-visual group.hashCode !== currentGroup.hashCode')
                await create(ctx, group, props)
            } else {
                // console.log('unit-visual update')
                if (group && !sameGroupConformation(group, currentGroup)) {
                    // console.log('unit-visual new conformation')
                    currentGroup = group
                }
                await update(ctx, props)
            }
        },
        getLoci(pickingId: PickingId) {
            return renderObject ? getLoci(pickingId, currentGroup, renderObject.id) : EmptyLoci
        },
        mark(loci: Loci, action: MarkerAction) {
            if (!renderObject) return false
            const { tMarker } = renderObject.values
            const { groupCount, instanceCount } = locationIt

            function apply(interval: Interval) {
                const start = Interval.start(interval)
                const end = Interval.end(interval)
                return applyMarkerAction(tMarker.ref.value.array, start, end, action)
            }

            let changed = false
            if (isEveryLoci(loci)) {
                changed = apply(Interval.ofBounds(0, groupCount * instanceCount))
            } else {
                changed = mark(loci, currentGroup, apply)
            }
            if (changed) {
                ValueCell.update(tMarker, tMarker.ref.value)
            }
            return changed
        },
        destroy() {
            // TODO
            renderObject = undefined
        }
    }
}