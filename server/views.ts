import type { Game } from "./game.js";
import type { HostView, Player, PlayerView } from "./types.js";

export function viewForPlayer(game: Game, player: Player): PlayerView {
    const name = player.name;
    const round = game.currentRound();
    
    switch (game.state.phase) {
        case "answering": {
            if (!round) return { name, phase: "lobby" };
            
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
            };
        }
        case "ranking":
        return { name, phase: "ranking", round: game.state.round, prompt: round?.prompt ?? "", answers: round?.answers ?? [] };
        case "lobby":
        return { name, phase: "lobby" };
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
            ranked: false,
            score: 0,
        })),
        answers: []
    };
}