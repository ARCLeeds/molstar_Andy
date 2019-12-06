/**
 * Copyright (c) 2018-2019 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

import { StructureElement } from './structure'
import { Link } from './structure/structure/unit/links'
import { Shape, ShapeGroup } from './shape';
import { Sphere3D } from '../mol-math/geometry';
import { CentroidHelper } from '../mol-math/geometry/centroid-helper';
import { Vec3 } from '../mol-math/linear-algebra';
import { OrderedSet } from '../mol-data/int';
import { Structure } from './structure/structure';
import { capitalize } from '../mol-util/string';
import { PrincipalAxes } from '../mol-math/linear-algebra/matrix/principal-axes';

/** A Loci that includes every loci */
export const EveryLoci = { kind: 'every-loci' as 'every-loci' }
export type EveryLoci = typeof EveryLoci
export function isEveryLoci(x?: Loci): x is EveryLoci {
    return !!x && x.kind === 'every-loci';
}

/** A Loci that is empty */
export const EmptyLoci = { kind: 'empty-loci' as 'empty-loci' }
export type EmptyLoci = typeof EmptyLoci
export function isEmptyLoci(x?: Loci): x is EmptyLoci {
    return !!x && x.kind === 'empty-loci';
}

/** A generic data loci */
export interface DataLoci {
    readonly kind: 'data-loci',
    readonly data: any,
    readonly tag: string
    readonly indices: OrderedSet<number>
}
export function isDataLoci(x?: Loci): x is DataLoci {
    return !!x && x.kind === 'data-loci';
}
export function areDataLociEqual(a: DataLoci, b: DataLoci) {
    return a.data === b.data && a.tag === b.tag && OrderedSet.areEqual(a.indices, b.indices)
}
export function isDataLociEmpty(loci: DataLoci) {
    return OrderedSet.size(loci.indices) === 0 ? true : false
}
export function createDataLoci(data: any, tag: string, indices: OrderedSet<number>): DataLoci {
    return { kind: 'data-loci', data, tag, indices }
}

export { Loci }

type Loci = StructureElement.Loci | Structure.Loci | Link.Loci | EveryLoci | EmptyLoci | DataLoci | Shape.Loci | ShapeGroup.Loci

namespace Loci {
    export type Pair = { lociA: Loci, lociB: Loci }
    export type Triple = { lociA: Loci, lociB: Loci, lociC: Loci }
    export type Quad = { lociA: Loci, lociB: Loci, lociC: Loci, lociD: Loci }

    export function areEqual(lociA: Loci, lociB: Loci) {
        if (isEveryLoci(lociA) && isEveryLoci(lociB)) return true
        if (isEmptyLoci(lociA) && isEmptyLoci(lociB)) return true
        if (isDataLoci(lociA) && isDataLoci(lociB)) {
            return areDataLociEqual(lociA, lociB)
        }
        if (Structure.isLoci(lociA) && Structure.isLoci(lociB)) {
            return Structure.areLociEqual(lociA, lociB)
        }
        if (StructureElement.Loci.is(lociA) && StructureElement.Loci.is(lociB)) {
            return StructureElement.Loci.areEqual(lociA, lociB)
        }
        if (Link.isLoci(lociA) && Link.isLoci(lociB)) {
            return Link.areLociEqual(lociA, lociB)
        }
        if (Shape.isLoci(lociA) && Shape.isLoci(lociB)) {
            return Shape.areLociEqual(lociA, lociB)
        }
        if (ShapeGroup.isLoci(lociA) && ShapeGroup.isLoci(lociB)) {
            return ShapeGroup.areLociEqual(lociA, lociB)
        }
        return false
    }

    export function isEvery(loci?: Loci): loci is EveryLoci {
        return !!loci && loci.kind === 'every-loci';
    }

    export function isEmpty(loci: Loci): loci is EmptyLoci {
        if (isEveryLoci(loci)) return false
        if (isEmptyLoci(loci)) return true
        if (isDataLoci(loci)) return isDataLociEmpty(loci)
        if (Structure.isLoci(loci)) return Structure.isLociEmpty(loci)
        if (StructureElement.Loci.is(loci)) return StructureElement.Loci.isEmpty(loci)
        if (Link.isLoci(loci)) return Link.isLociEmpty(loci)
        if (Shape.isLoci(loci)) return Shape.isLociEmpty(loci)
        if (ShapeGroup.isLoci(loci)) return ShapeGroup.isLociEmpty(loci)
        return false
    }

    export function remap<T>(loci: Loci, data: T) {
        if (data instanceof Structure) {
            if (StructureElement.Loci.is(loci)) {
                loci = StructureElement.Loci.remap(loci, data)
            } else if (Structure.isLoci(loci)) {
                loci = Structure.remapLoci(loci, data)
            } else if (Link.isLoci(loci)) {
                loci = Link.remapLoci(loci, data)
            }
        }
        return loci
    }

    const sphereHelper = new CentroidHelper(), tempPos = Vec3.zero();

    export function getBoundingSphere(loci: Loci, boundingSphere?: Sphere3D): Sphere3D | undefined {
        if (loci.kind === 'every-loci' || loci.kind === 'empty-loci') return void 0;

        if (!boundingSphere) boundingSphere = Sphere3D()
        sphereHelper.reset();

        if (loci.kind === 'structure-loci') {
            return Sphere3D.copy(boundingSphere, loci.structure.boundary.sphere)
        } else if (loci.kind === 'element-loci') {
            return StructureElement.Loci.getBoundary(loci).sphere;
        } else if (loci.kind === 'link-loci') {
            for (const e of loci.links) {
                e.aUnit.conformation.position(e.aUnit.elements[e.aIndex], tempPos);
                sphereHelper.includeStep(tempPos);
                e.bUnit.conformation.position(e.bUnit.elements[e.bIndex], tempPos);
                sphereHelper.includeStep(tempPos);
            }
            sphereHelper.finishedIncludeStep();
            for (const e of loci.links) {
                e.aUnit.conformation.position(e.aUnit.elements[e.aIndex], tempPos);
                sphereHelper.radiusStep(tempPos);
                e.aUnit.conformation.position(e.bUnit.elements[e.bIndex], tempPos);
                sphereHelper.radiusStep(tempPos);
            }
        } else if (loci.kind === 'shape-loci') {
            // TODO
            return void 0;
        } else if (loci.kind === 'group-loci') {
            // TODO
            return void 0;
        } else if (loci.kind === 'data-loci') {
            // TODO maybe add loci.getBoundingSphere()???
            return void 0;
        }

        Vec3.copy(boundingSphere.center, sphereHelper.center)
        boundingSphere.radius = Math.sqrt(sphereHelper.radiusSq)
        return boundingSphere
    }

    const tmpSphere3D = Sphere3D.zero()
    export function getCenter(loci: Loci, center?: Vec3): Vec3 | undefined {
        const boundingSphere = getBoundingSphere(loci, tmpSphere3D)
        return boundingSphere ? Vec3.copy(center || Vec3.zero(), boundingSphere.center) : undefined
    }

    export function getPrincipalAxes(loci: Loci): PrincipalAxes | undefined {
        if (loci.kind === 'every-loci' || loci.kind === 'empty-loci') return void 0;

        if (loci.kind === 'structure-loci') {
            return StructureElement.Loci.getPrincipalAxes(Structure.toStructureElementLoci(loci.structure))
        } else if (loci.kind === 'element-loci') {
            return StructureElement.Loci.getPrincipalAxes(loci)
        } else if (loci.kind === 'link-loci') {
            // TODO
            return void 0;
        } else if (loci.kind === 'shape-loci') {
            // TODO
            return void 0;
        } else if (loci.kind === 'group-loci') {
            // TODO
            return void 0;
        } else if (loci.kind === 'data-loci') {
            // TODO maybe add loci.getPrincipalAxes()???
            return void 0;
        }
    }

    //

    const Granularity = {
        'element': (loci: Loci) => loci,
        'residue': (loci: Loci) => {
            return StructureElement.Loci.is(loci)
                ? StructureElement.Loci.extendToWholeResidues(loci, true)
                : loci
        },
        'chain': (loci: Loci) => {
            return StructureElement.Loci.is(loci)
                ? StructureElement.Loci.extendToWholeChains(loci)
                : loci
        },
        'entity': (loci: Loci) => {
            return StructureElement.Loci.is(loci)
                ? StructureElement.Loci.extendToWholeEntities(loci)
                : loci
        },
        'model': (loci: Loci) => {
            return StructureElement.Loci.is(loci)
                ? StructureElement.Loci.extendToWholeModels(loci)
                : loci
        },
        'structure': (loci: Loci) => {
            return StructureElement.Loci.is(loci)
                ? Structure.toStructureElementLoci(loci.structure)
                : loci
        }
    }
    export type Granularity = keyof typeof Granularity
    export const GranularityOptions = Object.keys(Granularity).map(n => [n, capitalize(n)]) as [Granularity, string][]

    export function applyGranularity(loci: Loci, granularity: Granularity) {
        return Granularity[granularity](loci)
    }

    /**
     * Converts structure related loci to StructureElement.Loci and applies
     * granularity if given
    */
    export function normalize(loci: Loci, granularity?: Granularity) {
        if (granularity !== 'element' && Link.isLoci(loci)) {
            // convert Link.Loci to a StructureElement.Loci so granularity can be applied
            loci = Link.toStructureElementLoci(loci)
        }
        if (Structure.isLoci(loci)) {
            // convert to StructureElement.Loci
            loci = Structure.toStructureElementLoci(loci.structure)
        }
        if (StructureElement.Loci.is(loci)) {
            // ensure the root structure is used
            loci = StructureElement.Loci.remap(loci, loci.structure.root)
        }
        if (granularity) {
            // needs to be applied AFTER remapping to root
            loci = applyGranularity(loci, granularity)
        }
        return loci
    }
}