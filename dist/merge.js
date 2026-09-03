function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function mergeDeep(target, source) {
    if (!isRecord(target) || !isRecord(source))
        return source === undefined ? target : source;
    const output = { ...target };
    for (const [key, value] of Object.entries(source)) {
        if (value === undefined)
            continue;
        const existing = output[key];
        output[key] = isRecord(existing) && isRecord(value) ? mergeDeep(existing, value) : value;
    }
    return output;
}
