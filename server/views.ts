import type { Game } from "./game.js";
import type { HostView, Player, PlayerView } from "./types.js";

export function viewForPlayer(
    game: Game,
    player: Player,
    players: Iterable<Player>,
    readyPlayers: Set<string>,
    isHost: boolean,
): PlayerView {
    const roundPlayers = [...players];
    const name = player.name;
    const round = game.currentRound();
    
    switch (game.state.phase) {
        case "answering": {
            if (!round) return { name, phase: "lobby", isHost };
            
            const mine = round.answers.find(
                (a) => a.playerId === player.id,
            );
            
            return {
                name,
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
            name,
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
            name,
            phase: "lobby",
            isHost
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
        name,
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
        return { name, phase: "lobby", isHost };
    }
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
