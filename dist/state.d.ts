export type AnyRecord = Record<string, unknown>;
export type Checkpoint = {
    providerID: string;
    responseID: string;
    afterMessageID: string;
    afterCreatedAt: number;
    createdAt: number;
    items: AnyRecord[];
};
export type ControlMessage = {
    providerID: string;
    sessionID: string;
    messageID: string;
    createdAt: number;
    contentText: string;
};
export declare function compactedItemsFrom(value: unknown): AnyRecord[] | undefined;
export declare class CheckpointStore {
    private readonly db;
    private constructor();
    static open(file: string): Promise<CheckpointStore>;
    static openMemory(): CheckpointStore;
    close(): void;
    loadAll(): {
        sessionID: string;
        checkpoint: Checkpoint;
    }[];
    upsert(sessionID: string, checkpoint: Checkpoint): void;
    loadControlMessages(): ControlMessage[];
    upsertControlMessage(message: ControlMessage): void;
    deleteSession(sessionID: string): void;
    deleteCheckpoint(sessionID: string, providerID: string, responseID: string): void;
    deleteControlMessage(sessionID: string, messageID: string): void;
    prune(retentionDays: number): void;
    count(): number;
    version(): number;
    private migrate;
    private schemaVersion;
}
export declare const currentSchemaVersion = 2;
