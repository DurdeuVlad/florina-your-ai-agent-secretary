/**
 * Credential vault port — the core-owned outbound contract for secret
 * retrieval (DEC-022, DEC-037).
 *
 * The capability broker retrieves stored credentials through this port and
 * never sees the vault's storage backend. The concrete `CredentialBroker`
 * under `src/daemon/` satisfies it.
 */
export interface CredentialVaultPort {
  retrieveCredential(name: string): string | null;
}
