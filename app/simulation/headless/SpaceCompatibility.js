import { HeadlessEpisodeError } from "./HeadlessErrors.js";
import { hashSpace } from "./TensorProtocol.js";

export function assertCompatibleSpaces(expected, candidate) {
    const expectedAction = hashSpace(expected.actionSpace);
    const candidateAction = hashSpace(candidate.actionSpace);
    const expectedObservation = hashSpace(expected.observationSpace);
    const candidateObservation = hashSpace(candidate.observationSpace);
    if (expectedAction !== candidateAction || expectedObservation !== candidateObservation) {
        throw new HeadlessEpisodeError("INCOMPATIBLE_SPACE", "Action or observation space is incompatible with the existing environment pool.", {
            expectedAction,
            candidateAction,
            expectedObservation,
            candidateObservation,
        });
    }
    return { actionSpaceHash: expectedAction, observationSpaceHash: expectedObservation };
}
