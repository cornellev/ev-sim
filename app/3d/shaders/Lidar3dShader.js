import { MAX_BOXES, MAX_TRIANGLES } from "../data/ObjectDatabase";
import { Box } from "../data/objects/Box";
import { Triangle } from "../data/objects/Triangle";
import { common } from "./Shader";

export const frag3d = `
precision highp float;

// common defs
${common()}

// box struct
${new Box().getStruct().toString()}

// triangle struct
${new Triangle().getStruct().toString()}

// box array via data textures
#define MAX_BOXES ${MAX_BOXES}
#define MAX_TRIANGLES ${MAX_TRIANGLES}
uniform sampler2D u_boxPosTex;
uniform sampler2D u_boxScaleTex;
uniform int boxCount;

// every 3 points defines a triangle
uniform sampler2D u_triPosTex;
uniform sampler2D u_triTagTex;
uniform int triCount;

uniform sampler2D u_boxTagTex;

uniform vec3 u_origin;
uniform mat3 u_sensorRotation;

uniform float u_time;
uniform vec2 u_resolution;

uniform float u_thetaStart;
uniform float u_thetaEnd;
uniform float u_thetaStep;

uniform float u_phiStart;
uniform float u_phiEnd;
uniform float u_phiStep;

uniform float u_range;

// obx
${new Box().getSDF()}

// triangle (kept for potential future use)
${new Triangle().getSDF()}

// Möller–Trumbore ray-triangle intersection.
// Returns the distance along the ray to the hit, or -1.0 if no intersection.
float rayTriangleIntersect(vec3 orig, vec3 dir, vec3 v0, vec3 v1, vec3 v2) {
    vec3 e1 = v1 - v0;
    vec3 e2 = v2 - v0;
    vec3 h = cross(dir, e2);
    float a = dot(e1, h);
    if (abs(a) < 1e-6) return -1.0; // ray parallel to triangle
    float f = 1.0 / a;
    vec3 s = orig - v0;
    float u = f * dot(s, h);
    if (u < 0.0 || u > 1.0) return -1.0;
    vec3 q = cross(s, e1);
    float v = f * dot(dir, q);
    if (v < 0.0 || u + v > 1.0) return -1.0;
    float t = f * dot(e2, q);
    if (t < 1e-4) return -1.0; // behind origin
    return t;
}

struct Hit {
    bool hit;
    float distance;
    float tagId;
    float objectKind;
    float objectIndex;
};

Hit raycast(float theta, float phi) {
    // direction vector in 3D
    vec3 localDir = vec3(
        cos(phi) * cos(theta),
        sin(phi),
        cos(phi) * sin(theta)
    );
    vec3 dir = normalize(u_sensorRotation * localDir);

    // --- Exact triangle intersections (Möller–Trumbore) ---
    // SDF marching is unreliable for infinitely thin surfaces: a ray at a
    // shallow angle can step over the surface without ever triggering the
    // hit threshold. Analytical intersection has no such problem.
    float triHitDist = -1.0;
    int triHitIndex = -1;
    int tb = 0;
    for (int j = 0; j < MAX_TRIANGLES; j++) {
        if (tb >= triCount) break;
        float idx = float(j * 3);
        float texWidth = float(MAX_TRIANGLES * 3);
        vec2 uvA = vec2((idx + 0.5) / texWidth, 0.5);

        if (texture2D(u_triPosTex, uvA).w == 0.0) {
            continue;
        }

        vec3 va = texture2D(u_triPosTex, uvA).xyz;
        vec3 vb = texture2D(u_triPosTex, vec2((idx + 1.5) / texWidth, 0.5)).xyz;
        vec3 vc = texture2D(u_triPosTex, vec2((idx + 2.5) / texWidth, 0.5)).xyz;

        float t = rayTriangleIntersect(u_origin, dir, va, vb, vc);
        if (t > 0.0 && t < u_range) {
            if (triHitDist < 0.0 || t < triHitDist) {
                triHitDist = t;
                triHitIndex = j;
            }
        }

        ++tb;
    }

    // --- SDF march for boxes ---
    float totalDistance = 0.0;
    float maxDistance = u_range;
    float hitThreshold = 0.01;
    bool boxHit = false;
    int boxHitIndex = -1;
    
    for (int i = 0; i < 256; i++) {
        vec3 currentPos = u_origin + dir * totalDistance;
        
        float minDist = 10000.0;
        int closestBox = -1;
        int bb = 0;
        for (int j = 0; j < MAX_BOXES; j++) {
            if (bb >= boxCount) break;
            float idx = float(j);
            float texWidth = float(MAX_BOXES);
            float uCoord = (idx + 0.5) / texWidth;
            vec2 uv = vec2(uCoord, 0.5);

            if (texture2D(u_boxPosTex, uv).w == 0.0) {
                continue;
            }

            Box box;
            box.position = texture2D(u_boxPosTex, uv).xyz;
            box.scale = texture2D(u_boxScaleTex, uv).xyz;

            float dist = sdBox(currentPos, box);
            if (dist < minDist) {
                minDist = dist;
                closestBox = j;
            }

            ++bb;
        }
        
        if (minDist < hitThreshold) {
            boxHit = true;
            boxHitIndex = closestBox;
            break;
        }
        
        totalDistance += minDist * 0.9;
        if (totalDistance > maxDistance) {
            break;
        }
    }

    Hit result;
    result.hit = false;
    result.distance = totalDistance;
    result.tagId = 0.0;
    result.objectKind = -1.0;
    result.objectIndex = -1.0;

    if (boxHit && (triHitDist < 0.0 || totalDistance <= triHitDist)) {
        result.hit = true;
        result.distance = totalDistance;
        result.objectKind = 1.0;
        result.objectIndex = float(boxHitIndex);
        float uCoord = (float(boxHitIndex) + 0.5) / float(MAX_BOXES);
        result.tagId = texture2D(u_boxTagTex, vec2(uCoord, 0.5)).x;
    } else if (triHitDist > 0.0) {
        result.hit = true;
        result.distance = triHitDist;
        result.objectKind = 0.0;
        result.objectIndex = float(triHitIndex);
        float uCoord = (float(triHitIndex) + 0.5) / float(MAX_TRIANGLES);
        result.tagId = texture2D(u_triTagTex, vec2(uCoord, 0.5)).x;
    }

    return result;
}

void main() {
    // Map each pixel in the offscreen buffer to a unique
    // (theta, phi) pair. X corresponds to theta index,
    // Y corresponds to phi index.
    int xIndex = int(gl_FragCoord.x);
    int yIndex = int(gl_FragCoord.y);

    float theta = u_thetaStart + float(xIndex) * u_thetaStep;
    float phi   = u_phiStart + float(yIndex) * u_phiStep;

    float thetaRad = toRadians(theta);
    float phiRad   = toRadians(phi);

    Hit hitResult = raycast(thetaRad, phiRad);
    
    if (hitResult.hit) {
        float intensity = 1.0 - (hitResult.distance / u_range);
        float normalizedTag = hitResult.tagId / 255.0;
        gl_FragColor = vec4(intensity, normalizedTag, hitResult.objectKind, hitResult.hit ? 1.0 : 0.0);
    } else {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
    }
}
`;
