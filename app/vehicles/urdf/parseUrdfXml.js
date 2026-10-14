/** Isolated URDF XML parser. Conversion never fetches a URL. */

import { DOMParser } from "@xmldom/xmldom";

import { urdfIssue } from "./issue.js";

export const URDF_XML_MAX_BYTES = 4 * 1024 * 1024;

const FORBIDDEN_DECLARATION = /<!DOCTYPE|<!ENTITY|<!ELEMENT|<!ATTLIST|<!NOTATION/iu;
const XACRO_XMLNS = /xmlns(?::[\w.-]+)?\s*=\s*["'][^"']*xacro/iu;
const XACRO_TAG = /<\s*(?:[\w.-]+:)?xacro:/iu;

export class UrdfXmlError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "UrdfXmlError";
        this.code = code;
    }
}

function textOf(input) {
    if (typeof input === "string") return input;
    const bytes = input instanceof Uint8Array
        ? input
        : input instanceof ArrayBuffer
            ? new Uint8Array(input)
            : null;
    if (!bytes) throw new UrdfXmlError("vehicle.urdf.parse", "URDF XML must be a string or bytes.");
    if (bytes.byteLength > URDF_XML_MAX_BYTES) {
        throw new UrdfXmlError("vehicle.urdf.xml-limit", `URDF XML exceeds ${URDF_XML_MAX_BYTES} bytes.`);
    }
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function assertWithinLimit(text) {
    if (text.length > URDF_XML_MAX_BYTES) {
        throw new UrdfXmlError("vehicle.urdf.xml-limit", `URDF XML exceeds ${URDF_XML_MAX_BYTES} bytes.`);
    }
}

/**
 * Parse one XML document.
 * DTD and entity declarations are rejected before the parser runs.
 */
export function parseUrdfXml(input) {
    const text = textOf(input).replace(/^\uFEFF/u, "");
    assertWithinLimit(text);
    if (FORBIDDEN_DECLARATION.test(text)) {
        throw new UrdfXmlError("vehicle.urdf.entity", "URDF XML must not declare a DTD or entity.");
    }
    const parser = new DOMParser({
        onError(level, message) {
            const detail = message == null ? String(level) : `${level}: ${message}`;
            throw new UrdfXmlError("vehicle.urdf.parse", `URDF XML ${detail}`);
        },
    });
    let document;
    try {
        document = parser.parseFromString(text, "text/xml");
    } catch (error) {
        if (error instanceof UrdfXmlError) throw error;
        throw new UrdfXmlError("vehicle.urdf.parse", error.message);
    }
    const root = document?.documentElement;
    if (!root || String(root.nodeName).toLowerCase() === "parsererror") {
        throw new UrdfXmlError("vehicle.urdf.parse", "URDF XML did not parse.");
    }
    return { document, text };
}

export function urdfXmlIssues(error) {
    const code = error instanceof UrdfXmlError ? error.code : "vehicle.urdf.parse";
    return [urdfIssue(code, "", error.message)];
}

export function textUsesXacro(text, entryPath = "") {
    if (String(entryPath).toLowerCase().endsWith(".xacro")) return true;
    return XACRO_XMLNS.test(text) || XACRO_TAG.test(text);
}
