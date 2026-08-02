/**
 * paytacaConnect.ts
 *
 * WalletConnect v2 client for Paytaca on BCH Chipnet.
 *
 * This version validates the active session before every request and clears
 * stale WalletConnect sessions that can cause:
 *
 *   onRelayMessage() -> failed to process an inbound message
 *
 * Install:
 *   npm install @walletconnect/sign-client @walletconnect/modal
 */

import SignClient from "@walletconnect/sign-client";
import { WalletConnectModal } from "@walletconnect/modal";
import { stringify } from "@bitauth/libauth";

const WC_PROJECT_ID = "7df80f365033546fe911360fd2556203";

export const CHIPNET_CHAIN = "bch:bchtest";

const SESSION_STORAGE_KEY = "paytaca_wc_session_topic";

/**
 * Increment this value whenever the WalletConnect storage format or project
 * configuration changes. The old encrypted relay queue must be removed before
 * SignClient.init(), otherwise stale session_request messages are replayed.
 */
const WC_STORAGE_RESET_VERSION = "paytaca-wc-storage-reset-v2";

const WC_METADATA = {
  name: "PCSO Swertres Lotto",
  description:
    "Decentralized Digit Games on Bitcoin Cash Chipnet",
  url:
    typeof window !== "undefined"
      ? window.location.origin
      : "https://example.com",
  icons: [
    `${
      typeof window !== "undefined"
        ? window.location.origin
        : "https://example.com"
    }/favicon.ico`,
  ],
};

/**
 * Use requiredNamespaces here. A signing session is useless unless Paytaca
 * explicitly approves the BCH Chipnet chain and bch_signTransaction method.
 */
const REQUIRED_NAMESPACES = {
  bch: {
    chains: [CHIPNET_CHAIN],
    methods: [
      "bch_getAddresses",
      "bch_signTransaction",
      "bch_signMessage",
    ],
    events: ["addressesChanged"],
  },
};

let signClientPromise: Promise<SignClient> | undefined;
let modal: WalletConnectModal | undefined;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let currentSession: any;

function assertProjectIdConfigured(): void {
  if (!WC_PROJECT_ID.trim()) {
    throw new Error(
      "WalletConnect Project ID is not configured.",
    );
  }
}

function getModal(): WalletConnectModal {
  assertProjectIdConfigured();

  if (!modal) {
    modal = new WalletConnectModal({
      projectId: WC_PROJECT_ID,
      standaloneChains: [CHIPNET_CHAIN],
    });
  }

  return modal;
}

function clearCachedSession(): void {
  currentSession = undefined;

  if (typeof window !== "undefined") {
    window.localStorage.removeItem(
      SESSION_STORAGE_KEY,
    );
  }
}

function sessionSupportsSigning(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  session: any,
): boolean {
  const namespace = session?.namespaces?.bch;

  if (!namespace) {
    return false;
  }

  const chains: string[] =
    Array.isArray(namespace.chains)
      ? namespace.chains
      : [];

  const methods: string[] =
    Array.isArray(namespace.methods)
      ? namespace.methods
      : [];

  const accounts: string[] =
    Array.isArray(namespace.accounts)
      ? namespace.accounts
      : [];

  const hasChipnetChain =
    chains.includes(CHIPNET_CHAIN) ||
    accounts.some((account) =>
      account.startsWith(
        `${CHIPNET_CHAIN}:`,
      ),
    );

  return (
    hasChipnetChain &&
    methods.includes("bch_signTransaction") &&
    accounts.length > 0
  );
}

function isSessionExpired(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  session: any,
): boolean {
  const expiry = Number(session?.expiry);

  if (!Number.isFinite(expiry)) {
    return false;
  }

  return expiry * 1000 <= Date.now();
}


function deleteIndexedDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    if (
      typeof window === "undefined" ||
      !window.indexedDB
    ) {
      resolve();
      return;
    }

    const request =
      window.indexedDB.deleteDatabase(name);

    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => {
      console.warn(
        `WalletConnect database deletion was blocked: ${name}`,
      );
      resolve();
    };
  });
}

/**
 * WalletConnect processes its persisted relay queue while SignClient.init()
 * runs. Therefore stale data must be removed before initialization — calling
 * session.delete or disconnect afterward cannot prevent those startup errors.
 */
async function purgeLegacyWalletConnectStorageBeforeInit():
  Promise<void> {
  if (typeof window === "undefined") {
    return;
  }

  if (
    window.localStorage.getItem(
      WC_STORAGE_RESET_VERSION,
    ) === "done"
  ) {
    return;
  }

  window.localStorage.removeItem(
    SESSION_STORAGE_KEY,
  );

  for (
    let index = window.localStorage.length - 1;
    index >= 0;
    index -= 1
  ) {
    const key =
      window.localStorage.key(index);

    if (
      key &&
      (
        key.startsWith("wc@2:") ||
        key.startsWith("walletconnect") ||
        key.includes("WALLET_CONNECT")
      )
    ) {
      window.localStorage.removeItem(key);
    }
  }

  /**
   * WalletConnect v2 commonly persists its crypto keys, subscriptions, history,
   * and message queue in this IndexedDB database.
   */
  await deleteIndexedDatabase(
    "WALLET_CONNECT_V2_INDEXED_DB",
  );

  window.localStorage.setItem(
    WC_STORAGE_RESET_VERSION,
    "done",
  );
}

async function getSignClient(): Promise<SignClient> {
  assertProjectIdConfigured();

  if (!signClientPromise) {
    signClientPromise = (async () => {
      await purgeLegacyWalletConnectStorageBeforeInit();

      return SignClient.init({
        projectId: WC_PROJECT_ID,
        metadata: WC_METADATA,
      });
    })().then((client) => {

      client.on("session_delete", (event) => {
        if (
          !currentSession ||
          event.topic === currentSession.topic
        ) {
          clearCachedSession();
        }
      });

      client.on("session_expire", (event) => {
        if (
          !currentSession ||
          event.topic === currentSession.topic
        ) {
          clearCachedSession();
        }
      });

      client.on("session_update", (event) => {
        if (
          currentSession &&
          event.topic === currentSession.topic
        ) {
          try {
            currentSession =
              client.session.get(event.topic);
          } catch {
            clearCachedSession();
          }
        }
      });

      return client;
    });
  }

  return signClientPromise;
}

export interface PaytacaConnection {
  address: string;
  topic: string;
}

export interface RestoreResult {
  connection: PaytacaConnection | null;
  expiredStaleSession: boolean;
}

export interface PaytacaSignedTx {
  signedTransaction: string;
  signedTransactionHash: string;
}

function sessionToConnection(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  session: any,
): PaytacaConnection {
  const accounts: unknown =
    session?.namespaces?.bch?.accounts;

  if (
    !Array.isArray(accounts) ||
    typeof accounts[0] !== "string"
  ) {
    throw new Error(
      "Paytaca did not provide a BCH account.",
    );
  }

  const account = accounts[0];

  /**
   * Expected CAIP-10 form:
   * bch:bchtest:bchtest:q...
   *
   * Everything after the first two sections is the CashAddress.
   */
  const address =
    account.split(":").slice(2).join(":");

  if (!address) {
    throw new Error(
      `Invalid Paytaca account: ${account}`,
    );
  }

  return {
    address,
    topic: session.topic,
  };
}

async function resolveActiveSession(): Promise<{
  client: SignClient;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  session: any;
}> {
  const client = await getSignClient();

  const topic =
    currentSession?.topic ??
    (typeof window !== "undefined"
      ? window.localStorage.getItem(
          SESSION_STORAGE_KEY,
        )
      : null);

  if (!topic) {
    throw new Error(
      "Paytaca wallet is not connected.",
    );
  }

  let session;

  try {
    session = client.session.get(topic);
  } catch {
    clearCachedSession();

    throw new Error(
      "The Paytaca WalletConnect session is no longer valid. Disconnect and reconnect Paytaca.",
    );
  }

  if (
    isSessionExpired(session) ||
    !sessionSupportsSigning(session)
  ) {
    clearCachedSession();

    throw new Error(
      "The Paytaca session is expired or does not allow BCH transaction signing. Reconnect Paytaca.",
    );
  }

  currentSession = session;

  return {
    client,
    session,
  };
}

export async function restorePaytacaSession():
  Promise<RestoreResult> {
  const client = await getSignClient();

  const savedTopic =
    typeof window !== "undefined"
      ? window.localStorage.getItem(
          SESSION_STORAGE_KEY,
        )
      : null;

  if (!savedTopic) {
    return {
      connection: null,
      expiredStaleSession: false,
    };
  }

  let existing;

  try {
    existing = client.session.get(savedTopic);
  } catch {
    clearCachedSession();

    return {
      connection: null,
      expiredStaleSession: true,
    };
  }

  if (
    isSessionExpired(existing) ||
    !sessionSupportsSigning(existing)
  ) {
    try {
      await client.disconnect({
        topic: existing.topic,
        reason: {
          code: 6000,
          message:
            "Invalid or expired Paytaca session",
        },
      });
    } catch {
      // The wallet may already have removed it.
    }

    clearCachedSession();

    return {
      connection: null,
      expiredStaleSession: true,
    };
  }

  currentSession = existing;

  return {
    connection:
      sessionToConnection(existing),
    expiredStaleSession: false,
  };
}

/**
 * Deletes stale local sessions before making a new connection.
 */
async function cleanOldPaytacaSessions(
  client: SignClient,
): Promise<void> {
  const sessions = client.session
    .getAll()
    .filter((session) =>
      Boolean(session?.namespaces?.bch),
    );

  for (const session of sessions) {
    try {
      await client.disconnect({
        topic: session.topic,
        reason: {
          code: 6000,
          message:
            "Creating a fresh Paytaca connection",
        },
      });
    } catch {
      // Ignore sessions already removed by the wallet.
    }
  }

  clearCachedSession();
}

export async function connectPaytaca():
  Promise<PaytacaConnection> {
  const client = await getSignClient();
  const wcModal = getModal();

  /**
   * A stale topic can receive a wallet response that this browser can no
   * longer decrypt. Start from a fresh BCH session.
   */
  await cleanOldPaytacaSessions(client);

  const { uri, approval } =
    await client.connect({
      requiredNamespaces:
        REQUIRED_NAMESPACES,
    });

  if (uri) {
    await wcModal.openModal({ uri });
  }

  try {
    const session = await approval();

    if (!sessionSupportsSigning(session)) {
      try {
        await client.disconnect({
          topic: session.topic,
          reason: {
            code: 6000,
            message:
              "Required BCH signing method was not approved",
          },
        });
      } catch {
        // Ignore cleanup failure.
      }

      throw new Error(
        "Paytaca connected but did not approve BCH transaction signing.",
      );
    }

    currentSession = session;

    if (typeof window !== "undefined") {
      window.localStorage.setItem(
        SESSION_STORAGE_KEY,
        session.topic,
      );
    }

    return sessionToConnection(session);
  } finally {
    wcModal.closeModal();
  }
}

export async function disconnectPaytaca():
  Promise<void> {
  const client = await getSignClient();

  const topic =
    currentSession?.topic ??
    (typeof window !== "undefined"
      ? window.localStorage.getItem(
          SESSION_STORAGE_KEY,
        )
      : null);

  if (!topic) {
    clearCachedSession();
    return;
  }

  try {
    await client.disconnect({
      topic,
      reason: {
        code: 6000,
        message: "User disconnected",
      },
    });
  } catch {
    // The session can already be absent on Paytaca's side.
  } finally {
    clearCachedSession();
  }
}

/**
 * Use this after relay/decryption failures to guarantee that both cached and
 * SignClient-managed Paytaca sessions are removed.
 */
export async function resetPaytacaConnection():
  Promise<void> {
  const client = await getSignClient();

  await cleanOldPaytacaSessions(client);

  try {
    const pairings =
      client.pairing.getAll();

    for (const pairing of pairings) {
      try {
        await client.core.pairing.disconnect({
          topic: pairing.topic,
        });
      } catch {
        // Ignore pairings already deleted.
      }
    }
  } finally {
    clearCachedSession();
  }
}

export function isPaytacaConnected():
  boolean {
  return Boolean(currentSession);
}

export async function getPaytacaAddresses():
  Promise<string[]> {
  const { client, session } =
    await resolveActiveSession();

  return client.request<string[]>({
    chainId: CHIPNET_CHAIN,
    topic: session.topic,
    request: {
      method: "bch_getAddresses",
      params: {},
    },
  });
}


function stringifyUnknownError(error: unknown): string {
  const visited = new WeakSet<object>();

  const read = (value: unknown, depth = 0): string | null => {
    if (depth > 5) return null;

    if (value instanceof Error) {
      return value.message || value.name;
    }

    if (typeof value === "string") {
      return value.trim() || null;
    }

    if (
      typeof value === "number" ||
      typeof value === "boolean" ||
      typeof value === "bigint"
    ) {
      return String(value);
    }

    if (!value || typeof value !== "object") {
      return null;
    }

    if (visited.has(value)) {
      return null;
    }

    visited.add(value);

    const record = value as Record<string, unknown>;

    for (const key of [
      "message",
      "msg",
      "reason",
      "details",
      "description",
    ]) {
      const nested = read(record[key], depth + 1);

      if (nested) {
        const code =
          record.code ?? record.status ?? record.level;

        return code !== undefined
          ? `[${String(code)}] ${nested}`
          : nested;
      }
    }

    for (const key of [
      "error",
      "data",
      "cause",
      "response",
      "context",
    ]) {
      const nested = read(record[key], depth + 1);
      if (nested) return nested;
    }

    try {
      return JSON.stringify(value);
    } catch {
      return null;
    }
  };

  return read(error) ?? "Unknown WalletConnect error.";
}

function isSessionTransportError(message: string): boolean {
  return /relay|inbound message|decrypt|no matching key|topic|session|expired|keychain|symkey/i.test(
    message,
  );
}

/**
 * Sends CashScript's generated WalletConnect transaction object to Paytaca.
 */
export async function signWithPaytaca(
  wcTransactionObj: object,
): Promise<PaytacaSignedTx> {
  const { client, session } =
    await resolveActiveSession();

  const params =
    JSON.parse(
      stringify(wcTransactionObj),
    );

  try {
    const result =
      await client.request<PaytacaSignedTx>({
        chainId: CHIPNET_CHAIN,
        topic: session.topic,
        request: {
          method:
            "bch_signTransaction",
          params,
        },
      });

    if (!result || typeof result !== "object") {
      throw new Error(
        "Paytaca returned no transaction response.",
      );
    }

    const response =
      result as unknown as Record<string, unknown>;

    const hasSignedTransaction =
      typeof response.signedTransaction === "string" &&
      response.signedTransaction.length > 0;

    const hasTransactionHash =
      typeof response.signedTransactionHash === "string" &&
      response.signedTransactionHash.length > 0;

    if (!hasSignedTransaction && !hasTransactionHash) {
      throw new Error(
        `Paytaca returned an unexpected response: ${JSON.stringify(response)}`,
      );
    }

    return result;
  } catch (error) {
    const message =
      stringifyUnknownError(error);

    console.error(
      "Paytaca bch_signTransaction failed:",
      message,
      error,
    );

    if (isSessionTransportError(message)) {
      clearCachedSession();

      throw new Error(
        "The Paytaca WalletConnect session is invalid. Disconnect, reconnect using a new QR code, and try the payment again.",
      );
    }

    throw new Error(
      `Paytaca transaction failed: ${message}`,
    );
  }
}
