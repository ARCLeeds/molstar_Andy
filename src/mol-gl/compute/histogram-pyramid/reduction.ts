/**
 * Copyright (c) 2019-2020 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

import { createComputeRenderable } from '../../renderable';
import { WebGLContext } from '../../webgl/context';
import { createComputeRenderItem } from '../../webgl/render-item';
import { Values, TextureSpec, UniformSpec } from '../../renderable/schema';
import { Texture, TextureFilter, TextureFormat, TextureKind, TextureType } from '../../../mol-gl/webgl/texture';
import { ShaderCode } from '../../../mol-gl/shader-code';
import { ValueCell } from '../../../mol-util';
import { QuadSchema, QuadValues } from '../util';
import { Vec2 } from '../../../mol-math/linear-algebra';
import { getHistopyramidSum } from './sum';
import { Framebuffer } from '../../../mol-gl/webgl/framebuffer';
import { isPowerOfTwo } from '../../../mol-math/misc';
import quad_vert from '../../../mol-gl/shader/quad.vert';
import reduction_frag from '../../../mol-gl/shader/histogram-pyramid/reduction.frag';

const HistopyramidReductionSchema = {
    ...QuadSchema,
    tPreviousLevel: TextureSpec('texture', 'rgba', 'float', 'nearest'),
    uSize: UniformSpec('f'),
    uTexSize: UniformSpec('f'),
};

const HistogramPyramidName = 'histogram-pyramid';

function getHistopyramidReductionRenderable(ctx: WebGLContext, initialTexture: Texture) {
    if (ctx.namedComputeRenderables[HistogramPyramidName]) {
        const v = ctx.namedComputeRenderables[HistogramPyramidName].values;

        ValueCell.update(v.tPreviousLevel, initialTexture);

        ctx.namedComputeRenderables[HistogramPyramidName].update();
    } else {
        ctx.namedComputeRenderables[HistogramPyramidName] = createHistopyramidReductionRenderable(ctx, initialTexture);
    }
    return ctx.namedComputeRenderables[HistogramPyramidName];
}

function createHistopyramidReductionRenderable(ctx: WebGLContext, initialTexture: Texture) {
    const values: Values<typeof HistopyramidReductionSchema> = {
        ...QuadValues,
        tPreviousLevel: ValueCell.create(initialTexture),
        uSize: ValueCell.create(0),
        uTexSize: ValueCell.create(0),
    };

    const schema = { ...HistopyramidReductionSchema };
    const shaderCode = ShaderCode('reduction', quad_vert, reduction_frag);
    const renderItem = createComputeRenderItem(ctx, 'triangles', shaderCode, schema, values);

    return createComputeRenderable(renderItem, values);
}

type TextureFramebuffer = { texture: Texture, framebuffer: Framebuffer }
const LevelTexturesFramebuffers: TextureFramebuffer[] = [];
function getLevelTextureFramebuffer(ctx: WebGLContext, level: number) {
    let textureFramebuffer = LevelTexturesFramebuffers[level];
    const size = Math.pow(2, level);
    if (textureFramebuffer === undefined) {
        const texture = getTexture(`level${level}`, ctx, 'image-float32', 'rgba', 'float', 'nearest');
        const framebuffer = getFramebuffer(`level${level}`, ctx);
        texture.attachFramebuffer(framebuffer, 0);
        textureFramebuffer = { texture, framebuffer };
        textureFramebuffer.texture.define(size, size);
        LevelTexturesFramebuffers[level] = textureFramebuffer;
    }
    return textureFramebuffer;
}

function setRenderingDefaults(ctx: WebGLContext) {
    const { gl, state } = ctx;
    state.disable(gl.CULL_FACE);
    state.disable(gl.BLEND);
    state.disable(gl.DEPTH_TEST);
    state.disable(gl.SCISSOR_TEST);
    state.depthMask(false);
    state.colorMask(true, true, true, true);
    state.clearColor(0, 0, 0, 0);
}

function getFramebuffer(name: string, webgl: WebGLContext): Framebuffer {
    const _name = `${HistogramPyramidName}-${name}`;
    if (!webgl.namedFramebuffers[_name]) {
        webgl.namedFramebuffers[_name] = webgl.resources.framebuffer();
    }
    return webgl.namedFramebuffers[_name];
}

function getTexture(name: string, webgl: WebGLContext, kind: TextureKind, format: TextureFormat, type: TextureType, filter: TextureFilter): Texture {
    const _name = `${HistogramPyramidName}-${name}`;
    if (!webgl.namedTextures[_name]) {
        webgl.namedTextures[_name] = webgl.resources.texture(kind, format, type, filter);
    }
    return webgl.namedTextures[_name];
}

export interface HistogramPyramid {
    pyramidTex: Texture
    count: number
    height: number
    levels: number
    scale: Vec2
}

export function createHistogramPyramid(ctx: WebGLContext, inputTexture: Texture, scale: Vec2): HistogramPyramid {
    const { gl } = ctx;

    // printTexture(ctx, inputTexture, 2)
    if (inputTexture.getWidth() !== inputTexture.getHeight() || !isPowerOfTwo(inputTexture.getWidth())) {
        throw new Error('inputTexture must be of square power-of-two size');
    }

    // This part set the levels
    const levels = Math.ceil(Math.log(inputTexture.getWidth()) / Math.log(2));
    const maxSize = Math.pow(2, levels);
    // console.log('levels', levels, 'maxSize', maxSize, 'input', inputTexture.getWidth());

    const pyramidTexture = getTexture('pyramid', ctx, 'image-float32', 'rgba', 'float', 'nearest');
    pyramidTexture.define(maxSize, maxSize);

    const framebuffer = getFramebuffer('pyramid', ctx);
    pyramidTexture.attachFramebuffer(framebuffer, 0);
    gl.viewport(0, 0, maxSize, maxSize);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const levelTexturesFramebuffers: TextureFramebuffer[] = [];
    for (let i = 0; i < levels; ++i) levelTexturesFramebuffers.push(getLevelTextureFramebuffer(ctx, i));

    const renderable = getHistopyramidReductionRenderable(ctx, inputTexture);
    ctx.state.currentRenderItemId = -1;
    setRenderingDefaults(ctx);

    let offset = 0;
    for (let i = 0; i < levels; i++) {
        const currLevel = levels - 1 - i;
        const tf = levelTexturesFramebuffers[currLevel];
        tf.framebuffer.bind();
        // levelTextures[currLevel].attachFramebuffer(framebuffer, 0)

        const size = Math.pow(2, currLevel);
        // console.log('size', size, 'draw-level', currLevel, 'read-level', levels - i)

        ValueCell.update(renderable.values.uSize, Math.pow(2, i + 1) / maxSize);
        ValueCell.update(renderable.values.uTexSize, size);
        if (i > 0) {
            ValueCell.update(renderable.values.tPreviousLevel, levelTexturesFramebuffers[levels - i].texture);
            renderable.update();
        }
        ctx.state.currentRenderItemId = -1;
        gl.viewport(0, 0, size, size);
        gl.clear(gl.COLOR_BUFFER_BIT);
        renderable.render();

        pyramidTexture.bind(0);
        gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, offset, 0, 0, 0, size, size);
        pyramidTexture.unbind(0);

        offset += size;
    }

    gl.finish();

    // printTexture(ctx, pyramidTexture, 2)

    //

    const finalCount = getHistopyramidSum(ctx, levelTexturesFramebuffers[0].texture);
    const height = Math.ceil(finalCount / Math.pow(2, levels));
    // const scale = Vec2.create(maxSize / inputTexture.width, maxSize / inputTexture.height)
    // console.log('height', height, 'finalCount', finalCount, 'scale', scale)


    return {
        pyramidTex: pyramidTexture,
        count: finalCount,
        height,
        levels,
        scale
    };
}