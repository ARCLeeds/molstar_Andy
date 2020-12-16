/**
 * Copyright (c) 2019-2020 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Áron Samuel Kovács <aron.kovacs@mail.muni.cz>
 */

export default `
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D tSsaoDepth;
uniform vec2 uTexSize;

uniform float uKernel[dOcclusionKernelSize];

uniform float uBlurDirectionX;
uniform float uBlurDirectionY;

uniform float uMaxPossibleViewZDiff;

uniform float uNear;
uniform float uFar;

#include common

float perspectiveDepthToViewZ(const in float invClipZ, const in float near, const in float far) {
	return (near * far) / ((far - near) * invClipZ - far);
}

float orthographicDepthToViewZ(const in float linearClipZ, const in float near, const in float far) {
	return linearClipZ * (near - far) - near;
}

float getViewZ(const in float depth) {
	#if dOrthographic == 1
		return orthographicDepthToViewZ(depth, uNear, uFar);
	#else
		return perspectiveDepthToViewZ(depth, uNear, uFar);
	#endif
}

bool isBackground(const in float depth) {
    return depth >= 0.99;
}

void main(void) {
	vec2 coords = gl_FragCoord.xy / uTexSize;

    vec2 packedDepth = texture(tSsaoDepth, coords).zw;

    float selfDepth = unpackRGToUnitInterval(packedDepth);
    // if background and if second pass
	if (isBackground(selfDepth) && uBlurDirectionY != 0.0) {
       gl_FragColor = vec4(packUnitIntervalToRG(1.0), packedDepth);
       return;
    }

    float selfViewZ = getViewZ(selfDepth);

    vec2 offset = vec2(uBlurDirectionX, uBlurDirectionY) / uTexSize;

    float sum = 0.0;
    float kernelSum = 0.0;
    // only if kernelSize is odd
    for (int i = -dOcclusionKernelSize / 2; i <= dOcclusionKernelSize / 2; i++) {
        vec2 sampleCoords = coords + float(i) * offset;

        vec4 sampleSsaoDepth = texture(tSsaoDepth, sampleCoords);

        float sampleDepth = unpackRGToUnitInterval(sampleSsaoDepth.zw);
        if (isBackground(sampleDepth)) {
            continue;
        }

        if (abs(i) > 1) {
            float sampleViewZ = getViewZ(sampleDepth);
            if (abs(selfViewZ - sampleViewZ) > uMaxPossibleViewZDiff) {
                continue;
            }
        }

        float kernel = uKernel[abs(i)];
        float sampleValue = unpackRGToUnitInterval(sampleSsaoDepth.xy);

        sum += kernel * sampleValue;
        kernelSum += kernel;
    }
    
    gl_FragColor = vec4(packUnitIntervalToRG(sum / kernelSum), packedDepth);
}
`;