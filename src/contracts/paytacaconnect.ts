/**
 * paytacaConnect.ts
 *
 * Minimal WalletConnect v2 ("BCH WalletConnect" / wc2-bch-bcr spec) client for
 * pairing this dapp with the Paytaca wallet app on BCH **chipnet**.
 *
 * Requires:
 *   npm install @walletconnect/sign-client @walletconnect/modal
 *
 * Flow:
 *   1. connectPaytaca() opens a QR-code modal (and deep-links into Paytaca on
 *      mobile). Scanning/approving in Paytaca resolves the returned promise.
 *   2. Once connected, use getPaytacaAddresses() / signWithPaytaca() to interact.
 *   3. restorePaytacaSession() can be called on page load to silently resume
 *      a previous connection (topic is cached in localStorage).
 *
 * Persistence note: the WC session topic is cached in localStorage, so a
 * page refresh will silently resume the pairing as long as Paytaca's side
 * still considers the session valid. If Paytaca dropped it (app closed,
 * phone restarted, session expired, etc.) restorePaytacaSession() returns
 * null and clears the stale local record — see the `expiredStaleSession`
 * flag on the result for surfacing that in the UI instead of failing silently.
 */

import SignClient from "@walletconnect/sign-client";
import { WalletConnectModal } from "@walletconnect/modal";
import { stringify } from "@bitauth/libauth";

// --- Configuration ---------------------------------------------------------

// From https://cloud.reown.com
const WC_PROJECT_ID = "7df80f365033546fe911360fd2556203";

function assertProjectIdConfigured(): void {
  if (!WC_PROJECT_ID) {
    throw new Error("WalletConnect Project ID is not configured.");
  }
}

// CAIP-2 chain ids per the wc2-bch-bcr spec:
//   bch:bitcoincash -> mainnet
//   bch:bchtest     -> chipnet / testnet   <-- what we want here
//   bch:bchreg      -> regtest
export const CHIPNET_CHAIN = "bch:bchtest";

const WC_METADATA = {
  name: "PCSO Swertres Lotto",
  description: "Decentralized Digit Games on Bitcoin Cash (chipnet)",
  url:
    typeof window !== "undefined"
      ? window.location.origin
      : "https://example.com",
  icons: [
    `${typeof window !== "undefined" ? window.location.origin : "https://example.com"}/favicon.ico`,
  ],
};

// Note: newer @walletconnect/sign-client versions deprecate requiredNamespaces
// in favor of optionalNamespaces (both are accepted by wallets the same way,
// but requiredNamespaces triggers a console deprecation warning).
const OPTIONAL_NAMESPACES = {
  bch: {
    chains: [CHIPNET_CHAIN],
    methods: ["bch_getAddresses", "bch_signTransaction", "bch_signMessage"],
    events: ["addressesChanged"],
  },
};

const SESSION_STORAGE_KEY = "paytaca_wc_session_topic";

// --- Internal state ----------------------------------------------------

let signClientPromise: Promise<SignClient> | undefined;
let modal: WalletConnectModal | undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let currentSession: any;

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

async function getSignClient(): Promise<SignClient> {
  assertProjectIdConfigured();
  if (!signClientPromise) {
    signClientPromise = SignClient.init({
      projectId: WC_PROJECT_ID,
      relayUrl: "wss://relay.walletconnect.com",
      metadata: WC_METADATA,
    }).then((client) => {
      client.on("session_delete", () => {
        currentSession = undefined;
        localStorage.removeItem(SESSION_STORAGE_KEY);
      });
      return client;
    });
  }
  return signClientPromise;
}

export interface PaytacaConnection {
  /** Full chipnet cashaddr, e.g. "bchtest:qq..." */
  address: string;
  topic: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sessionToConnection(session: any): PaytacaConnection {
  // Account strings are CAIP-10: "bch:bchtest:<cashaddress>"
  const accountStr: string = session.namespaces.bch.accounts[0];
  const address = accountStr.split(":").slice(2).join(":");
  return { address, topic: session.topic };
}

export interface RestoreResult {
  connection: PaytacaConnection | null;
  /**
   * True when a saved session topic existed in localStorage but the
   * WalletConnect client no longer recognizes it as active (expired,
   * revoked from the Paytaca side, etc). Lets the UI show "reconnect
   * needed" instead of just quietly showing the disconnected state.
   */
  expiredStaleSession: boolean;
}

// --- Public API --------------------------------------------------------

/**
 * Attempts to resume a previously-approved Paytaca session (e.g. after a
 * page reload) without prompting the user.
 */
export async function restorePaytacaSession(): Promise<RestoreResult> {
  const client = await getSignClient();
  const savedTopic = localStorage.getItem(SESSION_STORAGE_KEY);
  if (!savedTopic) {
    return { connection: null, expiredStaleSession: false };
  }

  const existing = client.session.getAll().find((s) => s.topic === savedTopic);
  if (!existing) {
    localStorage.removeItem(SESSION_STORAGE_KEY);
    console.info(
      "Saved Paytaca session expired or was revoked on the wallet side — reconnect needed.",
    );
    return { connection: null, expiredStaleSession: true };
  }

  currentSession = existing;
  return {
    connection: sessionToConnection(existing),
    expiredStaleSession: false,
  };
}

/**
 * Opens the WalletConnect modal with a QR code scoped to BCH chipnet.
 * Resolves once the user approves the pairing inside Paytaca.
 * Rejects (or hangs) if the user rejects / closes the modal — wrap in try/catch.
 */
export async function connectPaytaca(): Promise<PaytacaConnection> {
  const client = await getSignClient();
  const wcModal = getModal();

  const { uri, approval } = await client.connect({
    optionalNamespaces: OPTIONAL_NAMESPACES,
  });

  if (uri) {
    // Shows QR code on desktop, deep-links into Paytaca on mobile.
    await wcModal.openModal({ uri });
  }

  try {
    const session = await approval();
    currentSession = session;
    localStorage.setItem(SESSION_STORAGE_KEY, session.topic);
    return sessionToConnection(session);
  } finally {
    wcModal.closeModal();
  }
}

export async function disconnectPaytaca(): Promise<void> {
  if (!signClientPromise || !currentSession) return;
  const client = await signClientPromise;
  try {
    await client.disconnect({
      topic: currentSession.topic,
      reason: { code: 6000, message: "User disconnected" },
    });
  } finally {
    currentSession = undefined;
    localStorage.removeItem(SESSION_STORAGE_KEY);
  }
}

export function isPaytacaConnected(): boolean {
  return !!currentSession;
}

export async function getPaytacaAddresses(): Promise<string[]> {
  if (!signClientPromise || !currentSession) {
    throw new Error("Paytaca wallet is not connected.");
  }
  const client = await signClientPromise;
  return client.request<string[]>({
    chainId: CHIPNET_CHAIN,
    topic: currentSession.topic,
    request: { method: "bch_getAddresses", params: {} },
  });
}

export interface PaytacaSignedTx {
  signedTransaction: string;
  signedTransactionHash: string;
}

/**
 * Sends a CashScript-generated WcTransactionObject (from
 * `transactionBuilder.generateWcTransactionObject()`) to Paytaca for signing.
 */
export async function signWithPaytaca(
  wcTransactionObj: object,
): Promise<PaytacaSignedTx> {
  if (!signClientPromise || !currentSession) {
    throw new Error("Paytaca wallet is not connected.");
  }
  const client = await signClientPromise;
  return client.request<PaytacaSignedTx>({
    chainId: CHIPNET_CHAIN,
    topic: currentSession.topic,
    request: {
      method: "bch_signTransaction",
      params: JSON.parse(stringify(wcTransactionObj)),
    },
  });
}
