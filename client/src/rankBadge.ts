export function createRankBadge(rank: number | null): HTMLSpanElement {
    const badge = document.createElement("span");
    badge.classList.add("leaderboard-rank");
    badge.dataset.rank = rank === null ? "unranked" : String(rank);
    badge.textContent = rank === null ? "" : `${rank}.`;
    badge.setAttribute("aria-label", rank === null ? "Not ranked yet" : `Rank ${rank}`);
    return badge;
}
