/** Inject at the durable post-effect boundary in both historical and current
 * producers. v3's terminal result follows this commit and version continuation. */
export function isMutationEffectCommit(type: string, data: any): boolean {
  return type === "file-mutation-progress-v2" && data?.phase === "result"
    || type === "file-mutation-progress-v3" && data?.version === 3 && JSON.parse(data.payload).phase === "commit";
}
