import type { Game } from "./game.js";
import type { HostView, Player, PlayerSummary, PlayerView } from "./types.js";

const MIN_PLAYERS_TO_START = 3;

export function viewForPlayer(
    game: Game,
    player: Player,
    players: Iterable<Player>,
    readyPlayers: Set<string>,
    activePlayerIds: Set<string>,
    hostPlayerId: string | null,
): PlayerView {
    const roomPlayers = [...players];
    const connectedPlayers = roomPlayers.filter(player => player.connected);
    const isHost = player.id === hostPlayerId;
    const isLobbyPhase = game.state.phase === "lobby";
    const isActive = isLobbyPhase || activePlayerIds.has(player.id);
    const isSpectator = !isLobbyPhase && !isActive;
    const activeConnectedPlayers = isLobbyPhase
        ? connectedPlayers
        : connectedPlayers.filter(player => activePlayerIds.has(player.id));
    const readyCount = activeConnectedPlayers.filter(player => readyPlayers.has(player.id)).length;
    const round = game.currentRound();
    const playerSummaries = summarizePlayers(
        game,
        roomPlayers,
        activePlayerIds,
        hostPlayerId,
    );
    const base = {
        name: player.name,
        isHost,
        isActive,
        isSpectator,
        players: playerSummaries,
    };
    const lobbyView = (): PlayerView => ({
        ...base,
        phase: "lobby",
        isHost,
        canStartRound: isHost && game.state.phase === "lobby" && connectedPlayers.length >= MIN_PLAYERS_TO_START,
        lobbyCount: game.state.phase === "results" ? readyCount : connectedPlayers.length,
        playerCount: game.state.phase === "results" ? activeConnectedPlayers.length : connectedPlayers.length,
    });

    if (game.state.phase === "results" && readyPlayers.has(player.id)) {
        return lobbyView();
    }

    switch (game.state.phase) {
        case "answering": {
            if (!round) return lobbyView();

            const mine = round.answers.find(
                (answer) => answer.playerId === player.id,
            );

            return {
                ...base,
                phase: "answering",
                round: game.state.round,
                prompt: round.prompt,
                words: round.words,
                submitted: mine?.words ?? null,
                answeredCount: activeConnectedPlayers.filter(player => round.answers.some(answer => answer.playerId === player.id)).length,
                playerCount: activeConnectedPlayers.length,
                canSubmit: isActive,
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
                hasRanked,
                rankedCount: activeConnectedPlayers.filter(player => round?.rankings.has(player.id)).length,
                playerCount: activeConnectedPlayers.length,
                canRank: isActive,
            };
        }
        case "results": {
            if (!round) return lobbyView();

            const roundResults = round.answers
                .map(answer => ({
                    playerName: roomPlayers.find(player => player.id === answer.playerId)?.name ?? "Unknown player",
                    words: answer.words,
                    score: round.scores?.get(answer.id) ?? 0,
                }))
                .sort((a, b) => b.score - a.score);

            const leaderboard = roomPlayers
                .map(player => ({
                    playerName: player.name,
                    totalScore: game.state.totals.get(player.id) ?? 0,
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
                readyCount,
                playerCount: activeConnectedPlayers.length,
                isReady: readyPlayers.has(player.id),
                canReady: isActive,
            };
        }
        case "lobby":
            return lobbyView();
    }
}

function summarizePlayers(
    game: Game,
    players: Player[],
    activePlayerIds: Set<string>,
    hostPlayerId: string | null,
): PlayerSummary[] {
    const round = game.currentRound();
    const isLobbyPhase = game.state.phase === "lobby";

    return players.map((player) => ({
        id: player.id,
        name: player.name,
        connected: player.connected,
        isHost: player.id === hostPlayerId,
        isActive: isLobbyPhase || activePlayerIds.has(player.id),
        answered: round?.answers.some((answer) => answer.playerId === player.id) ?? false,
        ranked: round?.rankings.has(player.id) ?? false,
        score: game.state.totals.get(player.id) ?? 0,
    }));
}

export function viewForHost(
    game: Game,
    players: Iterable<Player>,
    activePlayerIds: Set<string>,
): HostView {
    const round = game.currentRound();
    const isLobbyPhase = game.state.phase === "lobby";

    return {
        phase: game.state.phase,
        round: game.state.round,
        prompt: round?.prompt ?? null,
        players: [...players].map((player) => ({
            playerInfo: player,
            isActive: isLobbyPhase || activePlayerIds.has(player.id),
            answered: round?.answers.some((answer) => answer.playerId === player.id) ?? false,
            ranked: round?.rankings.has(player.id) ?? false,
            score: game.state.totals.get(player.id) ?? 0,
        })),
        answers: []
    };
}
