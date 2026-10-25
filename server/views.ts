import { MIN_PLAYERS_TO_START } from "./game.js";
import type { Game } from "./game.js";
import type { Answer, HostView, Player, PlayerSummary, PlayerView } from "./types.js";

export function viewForPlayer(
    game: Game,
    player: Player,
    players: Iterable<Player>,
    readyPlayers: Set<string>,
    activePlayerIds: Set<string>,
    hostPlayerId: string | null,
    roomLocked: boolean,
    stageEndsAt: number | null,
    botsEnabled: boolean,
): PlayerView {
    const roomPlayers = [...players];
    const connectedPlayers = roomPlayers.filter(player => player.connected);
    const isHost = player.id === hostPlayerId;
    const isLobbyPhase = game.state.phase === "lobby";
    const isActive = isLobbyPhase || activePlayerIds.has(player.id);
    const isSpectator = !isLobbyPhase && !isActive;
    const roundPlayers = isLobbyPhase
        ? connectedPlayers
        : roomPlayers.filter(player =>
            activePlayerIds.has(player.id) && (player.connected || player.reconnecting),
        );
    const readyCount = roundPlayers.filter(player => readyPlayers.has(player.id)).length;
    const round = game.currentRound();
    const playerSummaries = summarizePlayers(
        game,
        roomPlayers,
        activePlayerIds,
        hostPlayerId,
    );
    const timer = () => ({
        endsAt: stageEndsAt ?? Date.now(),
        serverNow: Date.now(),
    });
    const base = {
        playerId: player.id,
        name: player.name,
        isHost,
        isActive,
        isSpectator,
        players: playerSummaries,
        roomLocked,
        botsEnabled,
    };
    const lobbyView = (): PlayerView => ({
        ...base,
        phase: "lobby",
        isHost,
        canStartRound: isHost && game.state.phase === "lobby" && connectedPlayers.length >= MIN_PLAYERS_TO_START,
        lobbyCount: game.state.phase === "results" ? readyCount : connectedPlayers.length,
        playerCount: game.state.phase === "results" ? roundPlayers.length : connectedPlayers.length,
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
                words: round.wordsAvailable.get(player.id) ?? [],
                submitted: mine?.words ?? null,
                answeredCount: roundPlayers.filter(player => round.answers.some(answer => answer.playerId === player.id)).length,
                playerCount: roundPlayers.length,
                canSubmit: isActive,
                timer: timer(),
            };
        }
        case "ranking": {
            const hasRanked = round?.rankings.has(player.id) ?? false;
            return {
                ...base,
                phase: "ranking",
                round: game.state.round,
                prompt: round?.prompt ?? "",
                // only the other players' answers, without their author, and sorted by
                // their random id so the order does not reveal who submitted first
                answers: (round?.answers ?? [])
                    .filter(answer => answer.playerId !== player.id && !isOwnReusedAnswer(answer, player.id))
                    .map(answer => ({ id: answer.id, words: answer.words }))
                    .sort((a, b) => a.id.localeCompare(b.id)),
                hasRanked,
                rankedCount: roundPlayers.filter(player => round?.rankings.has(player.id)).length,
                playerCount: roundPlayers.length,
                canRank: isActive,
                timer: timer(),
            };
        }
        case "results": {
            if (!round) return lobbyView();

            const roundResults = round.answers
                .filter(answer => !isOwnReusedAnswer(answer, player.id))
                .map(answer => ({
                    playerId: answer.playerId,
                    playerName: roomPlayers.find(player => player.id === answer.playerId)?.name
                        ?? game.state.players.get(answer.playerId)?.name
                        ?? "Unknown player",
                    isBot: game.isBot(answer.playerId),
                    words: answer.words,
                    score: round.scores?.get(answer.id) ?? 0,
                }))
                .sort((a, b) => b.score - a.score);

            const leaderboard = roomPlayers
                .map(player => ({
                    playerId: player.id,
                    playerName: player.name,
                    totalScore: game.state.totals.get(player.id) ?? 0,
                }))
                .sort((a, b) => b.totalScore - a.totalScore)
                .map((player, index) => ({
                    playerId: player.playerId,
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
                playerCount: roundPlayers.length,
                isReady: readyPlayers.has(player.id),
                canReady: isActive,
            };
        }
        case "lobby":
            return lobbyView();
    }
}

// Bots never pick an answer by anyone in the room, but its author may join the room afterwards.
function isOwnReusedAnswer(answer: Answer, playerId: string): boolean {
    return answer.reusedFrom?.originalAuthorId === playerId;
}

function roundsPlayedBy(game: Game, playerId: string): number {
    return [...game.state.rounds.values()].filter(round =>
        round.playerIds.includes(playerId),
    ).length;
}
function summarizePlayers(
    game: Game,
    players: Player[],
    activePlayerIds: Set<string>,
    hostPlayerId: string | null,
): PlayerSummary[] {
    const round = game.currentRound();
    const isLobbyPhase = game.state.phase === "lobby";

    return players.map((player) => {
        const score = game.state.totals.get(player.id) ?? 0;
        const roundsPlayed = roundsPlayedBy(game, player.id);

        return {
            id: player.id,
            name: player.name,
            isBot: player.isBot === true,
            connected: player.connected,
            isHost: player.id === hostPlayerId,
            isActive: isLobbyPhase || activePlayerIds.has(player.id),
            answered: round?.answers.some((answer) => answer.playerId === player.id) ?? false,
            ranked: round?.rankings.has(player.id) ?? false,
            score,
            roundsPlayed,
            averageScore: roundsPlayed === 0 ? 0 : score / roundsPlayed,
        };
    });
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
