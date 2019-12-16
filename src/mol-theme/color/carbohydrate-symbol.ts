/**
 * Copyright (c) 2018-2019 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

import { StructureElement, Bond, ElementIndex, Unit } from '../../mol-model/structure';
import { SaccharideColors, MonosaccharidesColorTable } from '../../mol-model/structure/structure/carbohydrates/constants';
import { Location } from '../../mol-model/location';
import { ColorTheme, LocationColor } from '../color';
import { Color } from '../../mol-util/color';
import { ParamDefinition as PD } from '../../mol-util/param-definition'
import { ThemeDataContext } from '../theme';
import { TableLegend } from '../../mol-util/legend';

const DefaultColor = Color(0xCCCCCC)
const Description = 'Assigns colors according to the Symbol Nomenclature for Glycans (SNFG).'

export const CarbohydrateSymbolColorThemeParams = { }
export type CarbohydrateSymbolColorThemeParams = typeof CarbohydrateSymbolColorThemeParams
export function getCarbohydrateSymbolColorThemeParams(ctx: ThemeDataContext) {
    return CarbohydrateSymbolColorThemeParams // TODO return copy
}

export function CarbohydrateSymbolColorTheme(ctx: ThemeDataContext, props: PD.Values<CarbohydrateSymbolColorThemeParams>): ColorTheme<CarbohydrateSymbolColorThemeParams> {
    let color: LocationColor

    if (ctx.structure) {
        const { elements, getElementIndex, getAnomericCarbons } = ctx.structure.carbohydrates

        const getColor = (unit: Unit, index: ElementIndex) => {
            const residueIndex = unit.model.atomicHierarchy.residueAtomSegments.index[index]
            const anomericCarbons = getAnomericCarbons(unit, residueIndex)
            if (anomericCarbons.length > 0) {
                const idx = getElementIndex(unit, anomericCarbons[0])
                if (idx !== undefined) return elements[idx].component.color
            }
            return DefaultColor
        }

        color = (location: Location, isSecondary: boolean) => {
            if (isSecondary) {
                return SaccharideColors.Secondary
            } else {
                if (StructureElement.Location.is(location)) {
                    return getColor(location.unit, location.element)
                } else if (Bond.isLocation(location)) {
                    return getColor(location.aUnit, location.aUnit.elements[location.aIndex])
                }
            }
            return DefaultColor
        }
    } else {
        color = () => DefaultColor
    }

    return {
        factory: CarbohydrateSymbolColorTheme,
        granularity: 'group',
        color: color,
        props: props,
        description: Description,
        legend: TableLegend(MonosaccharidesColorTable)
    }
}

export const CarbohydrateSymbolColorThemeProvider: ColorTheme.Provider<CarbohydrateSymbolColorThemeParams> = {
    label: 'Carbohydrate Symbol',
    factory: CarbohydrateSymbolColorTheme,
    getParams: getCarbohydrateSymbolColorThemeParams,
    defaultValues: PD.getDefaultValues(CarbohydrateSymbolColorThemeParams),
    isApplicable: (ctx: ThemeDataContext) => !!ctx.structure && ctx.structure.carbohydrates.elements.length > 0
}