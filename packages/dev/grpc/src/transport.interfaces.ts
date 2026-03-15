/**
 * Transport interface — structurally identical to {@link IMessageTransport}
 * from `@dev/core`. Defined locally to avoid a build-time dependency on the
 * browser-targeted core package.
 *
 * TypeScript structural typing ensures full assignability in both directions.
 */
export interface IMessageTransport {
    send(data: string): void;
    onMessage: ((data: string) => void) | null;
    onOpen: (() => void) | null;
    onClose: (() => void) | null;
    onError: ((error: Error) => void) | null;
    readonly isOpen: boolean;
    close(): void;
}
