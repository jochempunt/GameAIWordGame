// All round-timer values are in milliseconds unless stated otherwise.
export const ANSWER_TIME = 60_000;

export const RANKING_MIN_TIME = 30_000;
export const RANKING_BASE_PLAYER_COUNT = 3;
export const RANKING_ADDITIONAL_TIME_PER_PLAYER = 1_000;
export const RANKING_PLAYER_COUNT_EXPONENT = 1.5;
export const ROUND_TIME_ROUNDING = 5_000;

export function rankingTimeForPlayerCount(playerCount: number): number {
    const playersAboveBaseline = Math.max(
        0,
        playerCount - RANKING_BASE_PLAYER_COUNT,
    );
    const unrounded = RANKING_MIN_TIME
        + RANKING_ADDITIONAL_TIME_PER_PLAYER
        * playersAboveBaseline ** RANKING_PLAYER_COUNT_EXPONENT;

    return Math.max(
        RANKING_MIN_TIME,
        Math.round(unrounded / ROUND_TIME_ROUNDING) * ROUND_TIME_ROUNDING,
    );
}