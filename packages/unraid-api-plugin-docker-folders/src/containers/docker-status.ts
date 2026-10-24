/** Readings of the status line in Docker's container list. Mirrors `DockerClient` in PHP. */

const AGE_UNITS: Record<string, number> = {
    second: 1,
    minute: 60,
    hour: 3600,
    day: 86400,
    week: 604800,
    month: 2592000,
    year: 31536000,
};

/**
 * The most seconds ago the exit in a status line can have been, from Docker's
 * HumanDuration wording, or null when the line has no age Docker would write.
 */
export function statusAgeUpperBound(status: string): number | null {
    const age = /\) (.+) ago$/.exec(status)?.[1];
    return age === undefined ? null : durationUpperBound(age);
}

/**
 * The most seconds a running container can have been up, from a status line
 * such as "Up 19 hours (healthy)", or null for any other line.
 */
export function uptimeUpperBound(status: string): number | null {
    const age = /^Up (.+?)(?: \([^)]*\))?$/.exec(status)?.[1];
    return age === undefined ? null : durationUpperBound(age);
}

/** Docker's HumanDuration wording ("About an hour", "5 minutes") as its most seconds. */
function durationUpperBound(age: string): number | null {
    if (age === 'Less than a second') return 1;
    if (age === 'About a minute') return 120;
    if (age === 'About an hour') return 5400;
    const match = /^(\d+) (second|minute|hour|day|week|month|year)s?$/.exec(age);
    if (!match) return null;
    const count = Number(match[1]);
    const unit = AGE_UNITS[match[2]];
    // Hours are rounded to the nearest, the rest are whole units.
    return match[2] === 'hour' ? Math.trunc((count + 0.5) * unit) : (count + 1) * unit;
}
