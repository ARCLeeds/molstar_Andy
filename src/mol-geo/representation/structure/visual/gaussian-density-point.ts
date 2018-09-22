/**
 * Copyright (c) 2018 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

import { Unit, Structure } from 'mol-model/structure';
import { RuntimeContext } from 'mol-task'
import { UnitsVisual, VisualUpdateState } from '..';
import { StructureElementIterator } from './util/element';
import { EmptyLoci } from 'mol-model/loci';
import { Vec3 } from 'mol-math/linear-algebra';
import { UnitsPointsVisual, DefaultUnitsPointsProps } from '../units-visual';
import { computeGaussianDensity, DefaultGaussianDensityProps } from './util/gaussian';
import { Points } from '../../../geometry/points/points';
import { PointsBuilder } from '../../../geometry/points/points-builder';
import { SizeThemeProps } from 'mol-view/theme/size';

export const DefaultGaussianDensityPointProps = {
    ...DefaultUnitsPointsProps,
    ...DefaultGaussianDensityProps,

    sizeTheme: { name: 'uniform', value: 1 } as SizeThemeProps,
    pointSizeAttenuation: false,
}
export type GaussianDensityPointProps = typeof DefaultGaussianDensityPointProps

export async function createGaussianDensityPoint(ctx: RuntimeContext, unit: Unit, structure: Structure, props: GaussianDensityPointProps, points?: Points) {
    const { transform, field: { space, data } } = await computeGaussianDensity(unit, structure, props).runAsChild(ctx)

    const { dimensions, get } = space
    const [ xn, yn, zn ] = dimensions

    const n = xn * yn * zn * 3
    const builder = PointsBuilder.create(n, n / 10, points)

    const p = Vec3.zero()
    let i = 0

    for (let x = 0; x < xn; ++x) {
        for (let y = 0; y < yn; ++y) {
            for (let z = 0; z < zn; ++z) {
                if (get(data, x, y, z) > 0.001) {
                    Vec3.set(p, x, y, z)
                    Vec3.transformMat4(p, p, transform)
                    builder.add(p[0], p[1], p[2], i)
                }
                if (i % 100000 === 0 && ctx.shouldUpdate) {
                    await ctx.update({ message: 'Creating density points', current: i, max: n });
                }
                ++i
            }
        }
    }
    return builder.getPoints()
}

export function GaussianDensityPointVisual(): UnitsVisual<GaussianDensityPointProps> {
    return UnitsPointsVisual<GaussianDensityPointProps>({
        defaultProps: DefaultGaussianDensityPointProps,
        createPoints: createGaussianDensityPoint,
        createLocationIterator: StructureElementIterator.fromGroup,
        getLoci: () => EmptyLoci,
        mark: () => false,
        setUpdateState: (state: VisualUpdateState, newProps: GaussianDensityPointProps, currentProps: GaussianDensityPointProps) => {
            if (newProps.resolutionFactor !== currentProps.resolutionFactor) state.createGeometry = true
            if (newProps.radiusOffset !== currentProps.radiusOffset) state.createGeometry = true
            if (newProps.smoothness !== currentProps.smoothness) state.createGeometry = true
        }
    })
}