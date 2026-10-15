import { MAX_BOXES, MAX_SPHERES, MAX_TRIANGLES } from "../data/ObjectDatabase";
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
#define MAX_SPHERES ${MAX_SPHERES}
uniform sampler2D u_boxPosTex;
uniform sampler2D u_boxScaleTex;
uniform int boxCount;

// every 3 points defines a triangle
uniform sampler2D u_triPosTex;
uniform sampler2D u_triTagTex;
uniform int triCount;

uniform sampler2D u_boxTagTex;

uniform sampler2D u_spherePosTex;
uniform sampler2D u_sphereTagTex;
uniform int sphereCount;

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
uniform float u_excludedInstanceId;

// 0 keeps the spherical scan used by sensor products. 1 casts one pinhole
// ray per pixel through the theta/phi frustum, for the viewport preview.
uniform int u_pinhole;

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

// Exact slab intersection for the axis-aligned boxes stored by ObjectDatabase.
// This replaces the old SDF marcher and has only the shader's 1e-6 parallel-ray
// tolerance; distance is the metric ray parameter because dir is normalized.
float rayBoxIntersect(vec3 orig, vec3 dir, vec3 center, vec3 size, out vec3 normal) {
    vec3 halfSize = size * 0.5;
    vec3 safeDir = vec3(
        abs(dir.x) < 1e-6 ? (dir.x < 0.0 ? -1e-6 : 1e-6) : dir.x,
        abs(dir.y) < 1e-6 ? (dir.y < 0.0 ? -1e-6 : 1e-6) : dir.y,
        abs(dir.z) < 1e-6 ? (dir.z < 0.0 ? -1e-6 : 1e-6) : dir.z
    );
    vec3 t0 = (center - halfSize - orig) / safeDir;
    vec3 t1 = (center + halfSize - orig) / safeDir;
    vec3 tMin = min(t0, t1);
    vec3 tMax = max(t0, t1);
    float nearT = max(tMin.x, max(tMin.y, tMin.z));
    float farT = min(tMax.x, min(tMax.y, tMax.z));
    if (farT < max(nearT, 0.0)) return -1.0;
    float hitT = nearT > 1e-4 ? nearT : farT;
    if (hitT < 1e-4) return -1.0;
    vec3 local = (orig + dir * hitT - center) / max(halfSize, vec3(1e-6));
    vec3 absoluteLocal = abs(local);
    if (absoluteLocal.x >= absoluteLocal.y && absoluteLocal.x >= absoluteLocal.z) {
        normal = vec3(sign(local.x), 0.0, 0.0);
    } else if (absoluteLocal.y >= absoluteLocal.z) {
        normal = vec3(0.0, sign(local.y), 0.0);
    } else {
        normal = vec3(0.0, 0.0, sign(local.z));
    }
    return hitT;
}

// Sphere signed distance. The ray hit is the nearest positive root of this
// function, solved directly rather than marched.
float sdSphere(vec3 p, vec3 center, float radius) {
    return length(p - center) - radius;
}

float raySphereDistance(vec3 orig, vec3 dir, vec3 center, float radius, out vec3 normal) {
    vec3 oc = orig - center;
    float b = dot(oc, dir);
    float c = dot(oc, oc) - radius * radius;
    float discriminant = b * b - c;
    if (discriminant < 0.0) return -1.0;
    float root = sqrt(discriminant);
    float nearT = -b - root;
    float farT = -b + root;
    float hitT = nearT > 1e-4 ? nearT : farT;
    if (hitT < 1e-4) return -1.0;
    vec3 hit = orig + dir * hitT;
    normal = normalize(hit - center);
    return hitT;
}

struct Hit {
    bool hit;
    float distance;
    float incidence;
    float tagId;
    float instanceId;
};

Hit raycast(float theta, float phi) {
    // Spherical scans stay the default when u_pinhole is 0. Pinhole mode
    // matches a perspective camera: x is tan(theta) across the frustum and
    // y is tan(phi), then the ray is normalize(1, y, x) in sensor space.
    vec3 localDir;
    if (u_pinhole == 1) {
        float u = gl_FragCoord.x / max(u_resolution.x, 1.0);
        float v = gl_FragCoord.y / max(u_resolution.y, 1.0);
        float xPlane = mix(tan(toRadians(u_thetaStart)), tan(toRadians(u_thetaEnd)), u);
        float yPlane = mix(tan(toRadians(u_phiStart)), tan(toRadians(u_phiEnd)), v);
        localDir = normalize(vec3(1.0, yPlane, xPlane));
    } else {
        localDir = vec3(
            cos(phi) * cos(theta),
            sin(phi),
            cos(phi) * sin(theta)
        );
    }
    vec3 dir = normalize(u_sensorRotation * localDir);

    // --- Exact triangle intersections (Möller–Trumbore) ---
    // SDF marching is unreliable for infinitely thin surfaces: a ray at a
    // shallow angle can step over the surface without ever triggering the
    // hit threshold. Analytical intersection has no such problem.
    float triHitDist = -1.0;
    float triHitIncidence = 0.0;
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
        vec4 triTag = texture2D(u_triTagTex, vec2((float(j) + 0.5) / float(MAX_TRIANGLES), 0.5));
        if (u_excludedInstanceId > 0.0 && triTag.y == u_excludedInstanceId) {
            ++tb;
            continue;
        }

        float t = rayTriangleIntersect(u_origin, dir, va, vb, vc);
        if (t > 0.0 && t < u_range) {
            if (triHitDist < 0.0 || t < triHitDist) {
                triHitDist = t;
                triHitIndex = j;
                triHitIncidence = abs(dot(-dir, normalize(cross(vb - va, vc - va))));
            }
        }

        ++tb;
    }

    // --- Exact analytic intersections for axis-aligned boxes ---
    float boxHitDist = -1.0;
    float boxHitIncidence = 0.0;
    int boxHitIndex = -1;
    int bb = 0;
    for (int j = 0; j < MAX_BOXES; j++) {
        if (bb >= boxCount) break;
        float idx = float(j);
        float texWidth = float(MAX_BOXES);
        vec2 uv = vec2((idx + 0.5) / texWidth, 0.5);
        if (texture2D(u_boxPosTex, uv).w == 0.0) continue;
        vec4 boxTag = texture2D(u_boxTagTex, uv);
        if (u_excludedInstanceId > 0.0 && boxTag.y == u_excludedInstanceId) {
            ++bb;
            continue;
        }
        vec3 center = texture2D(u_boxPosTex, uv).xyz;
        vec3 size = texture2D(u_boxScaleTex, uv).xyz;
        vec3 normal;
        float distance = rayBoxIntersect(u_origin, dir, center, size, normal);
        if (distance > 0.0 && distance <= u_range && (boxHitDist < 0.0 || distance < boxHitDist)) {
            boxHitDist = distance;
            boxHitIndex = j;
            boxHitIncidence = abs(dot(-dir, normal));
        }
        ++bb;
    }

    float sphereHitDist = -1.0;
    float sphereHitIncidence = 0.0;
    int sphereHitIndex = -1;
    int sb = 0;
    for (int j = 0; j < MAX_SPHERES; j++) {
        if (sb >= sphereCount) break;
        float idx = float(j);
        float texWidth = float(MAX_SPHERES);
        vec2 uv = vec2((idx + 0.5) / texWidth, 0.5);
        vec4 encoded = texture2D(u_spherePosTex, uv);
        if (encoded.w <= 0.0) {
            ++sb;
            continue;
        }
        vec4 sphereTag = texture2D(u_sphereTagTex, uv);
        if (u_excludedInstanceId > 0.0 && sphereTag.y == u_excludedInstanceId) {
            ++sb;
            continue;
        }
        vec3 normal;
        float distance = raySphereDistance(u_origin, dir, encoded.xyz, encoded.w, normal);
        if (distance > 0.0 && distance <= u_range && (sphereHitDist < 0.0 || distance < sphereHitDist)) {
            sphereHitDist = distance;
            sphereHitIndex = j;
            sphereHitIncidence = abs(dot(-dir, normal));
        }
        ++sb;
    }

    Hit result;
    result.hit = false;
    result.distance = 0.0;
    result.incidence = 0.0;
    result.tagId = 0.0;
    result.instanceId = 0.0;

    float bestDist = -1.0;
    int bestKind = 0;
    if (boxHitDist > 0.0) {
        bestDist = boxHitDist;
        bestKind = 1;
    }
    if (triHitDist > 0.0 && (bestDist < 0.0 || triHitDist < bestDist)) {
        bestDist = triHitDist;
        bestKind = 2;
    }
    if (sphereHitDist > 0.0 && (bestDist < 0.0 || sphereHitDist < bestDist)) {
        bestDist = sphereHitDist;
        bestKind = 3;
    }
    if (bestKind == 1) {
        result.hit = true;
        result.distance = boxHitDist;
        result.incidence = boxHitIncidence;
        float uCoord = (float(boxHitIndex) + 0.5) / float(MAX_BOXES);
        vec4 tag = texture2D(u_boxTagTex, vec2(uCoord, 0.5));
        result.tagId = tag.x;
        result.instanceId = tag.y;
    } else if (bestKind == 2) {
        result.hit = true;
        result.distance = triHitDist;
        result.incidence = triHitIncidence;
        float uCoord = (float(triHitIndex) + 0.5) / float(MAX_TRIANGLES);
        vec4 tag = texture2D(u_triTagTex, vec2(uCoord, 0.5));
        result.tagId = tag.x;
        result.instanceId = tag.y;
    } else if (bestKind == 3) {
        result.hit = true;
        result.distance = sphereHitDist;
        result.incidence = sphereHitIncidence;
        float uCoord = (float(sphereHitIndex) + 0.5) / float(MAX_SPHERES);
        vec4 tag = texture2D(u_sphereTagTex, vec2(uCoord, 0.5));
        result.tagId = tag.x;
        result.instanceId = tag.y;
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
        gl_FragColor = vec4(hitResult.distance, hitResult.incidence, hitResult.tagId, hitResult.instanceId);
    } else {
        // All-zero is the explicit no-hit sentinel.
        gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
    }
}
`;
