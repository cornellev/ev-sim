const semver = Object.freeze({
    valid: (value) => String(value),
    validRange: (value) => String(value),
    satisfies: () => true,
});

export default semver;
