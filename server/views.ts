import type { Game } from "./game.js";
import type { HostView, Player, PlayerSummary, PlayerView } from "./types.js";

export function viewForPlayer(
    game: Game,
    player: Player,
    players: Iterable<Player>,
    readyPlayers: Set<string>,
    hostPlayerId: string | null,
): PlayerView {
    const roundPlayers = [...players];
    const name = player.name;
    const round = game.currentRound();
    const isHost = player.id === hostPlayerId;
    const playerSummaries = summarizePlayers(
        game,
        roundPlayers,
        hostPlayerId,
    );
    const base = {
        name,
        isHost,
        players: playerSummaries,
    };

    switch (game.state.phase) {
        case "answering": {
            if (!round) return { ...base, phase: "lobby" };

            const mine = round.answers.find(
                (a) => a.playerId === player.id,
            );

            return {
                ...base,
                phase: "answering",
                round: game.state.round,
                prompt: round.prompt,
                words: round.words,
                submitted: mine?.words ?? null,
                answeredCount: roundPlayers.filter(p => round.answers.some(a => a.playerId === p.id)).length,
                playerCount: roundPlayers.length,
            };
        }
        case "ranking": {
            const hasRanked = round?.rankings.has(player.id) ?? false;
            return {
                ...base,
                phase: "ranking",
                round: game.state.round,
                prompt: round?.prompt ?? "",
                answers: round?.answers ?? [],
                hasRanked: hasRanked,
                rankedCount: roundPlayers.filter(p => round?.rankings.has(p.id)).length,
                playerCount: roundPlayers.length,
            };
        }
        case "results": {
            if (!round) {
                return {
                    ...base,
                    phase: "lobby",
                };
            }

            const roundResults = round.answers
                .map(answer => ({
                    playerName: roundPlayers.find(player => player.id === answer.playerId)?.name ?? "Unknown player",
                    words: answer.words,
                    score:
                        round.scores?.get(answer.id) ?? 0,
                }))
                .sort((a, b) => b.score - a.score);

            const leaderboard = roundPlayers
                .map(player => ({
                    playerName: player.name,
                    totalScore:
                        game.state.totals.get(player.id) ?? 0,
                }))
                .sort((a, b) => b.totalScore - a.totalScore)
                .map((player, index) => ({
                    playerName: player.playerName,
                    rank: index + 1,
                }));

            return {
                ...base,
                phase: "results",
                round: game.state.round,
                prompt: round.prompt,
                roundResults,
                leaderboard,
                readyCount: readyPlayers.size,
                playerCount: roundPlayers.length,
                isReady: readyPlayers.has(player.id),
            };
        }
        case "lobby":
            return { ...base, phase: "lobby" };
    }
}

function summarizePlayers(
    game: Game,
    players: Player[],
    hostPlayerId: string | null,
): PlayerSummary[] {
    const round = game.currentRound();

    return players.map((player) => ({
        name: player.name,
        connected: player.connected,
        isHost: player.id === hostPlayerId,
        answered: round?.answers.some((answer) => answer.playerId === player.id) ?? false,
        ranked: round?.rankings.has(player.id) ?? false,
        score: game.state.totals.get(player.id) ?? 0,
    }));
}

export function viewForHost(
    game: Game,
    players: Iterable<Player>,
): HostView {
    const round = game.currentRound();

    return {
        phase: game.state.phase,
        round: game.state.round,
        prompt: round?.prompt ?? null,
        players: [...players].map((p) => ({
            playerInfo: p,
            answered: round?.answers.some((a) => a.playerId === p.id) ?? false,
            ranked: round?.rankings.has(p.id) ?? false,
            score: game.state.totals.get(p.id) ?? 0,
        })),
        answers: []
    };
}