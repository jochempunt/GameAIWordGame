// Bump this version when the participant information or data collection terms change.
export const CONSENT_VERSION = "2026-10-19-v1";

export type ConsentRecord = {
    version: string;
    participation: true;
    dataCollection: true;
    acceptedAt: string;
};

export function isCurrentConsent(value: unknown): value is ConsentRecord {
    if (!value || typeof value !== "object") return false;
    const consent = value as Partial<ConsentRecord>;
    return consent.version === CONSENT_VERSION
        && consent.participation === true
        && consent.dataCollection === true
        && typeof consent.acceptedAt === "string"
        && Number.isFinite(Date.parse(consent.acceptedAt));
}
