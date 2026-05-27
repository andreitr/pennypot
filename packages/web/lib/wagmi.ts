import { getDefaultConfig } from "connectkit";
import { createConfig, http } from "wagmi";
import { base, mainnet } from "wagmi/chains";

// ConnectKit's getDefaultConfig wires up a sensible default wallet set (Injected,
// Coinbase Wallet, WalletConnect, Safe) plus storage + ssr glue. We just pass it
// through createConfig.
//
// WalletConnect requires a free project id from https://cloud.walletconnect.com.
// If unset, Injected + Coinbase Wallet still work; WalletConnect-based wallets
// will fail to connect.
const projectId =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "pennypot-dev-placeholder";

// All frontend RPC goes through Alchemy when NEXT_PUBLIC_ALCHEMY_API_KEY is set.
// NEXT_PUBLIC_BASE_RPC_URL is honored as an explicit override; otherwise viem's
// default Base RPC is used (rate-limited).
const alchemyKey = process.env.NEXT_PUBLIC_ALCHEMY_API_KEY;
const baseRpcUrl =
  process.env.NEXT_PUBLIC_BASE_RPC_URL ||
  (alchemyKey ? `https://base-mainnet.g.alchemy.com/v2/${alchemyKey}` : undefined);
// Ethereum mainnet transport is for ENS resolution only (ConnectKit looks up
// the connected wallet's ENS name on chain 1). Without this, ConnectKit falls
// back to a public RPC that CORS-blocks browsers and spams the console.
const mainnetRpcUrl = alchemyKey
  ? `https://eth-mainnet.g.alchemy.com/v2/${alchemyKey}`
  : undefined;

export const wagmiConfig = createConfig(
  getDefaultConfig({
    appName: "PennyPot",
    appDescription: "1¢ shares of Megapot lottery tickets on Base",
    appUrl: "https://github.com/andreitr/pennypot",
    walletConnectProjectId: projectId,
    chains: [base, mainnet],
    transports: {
      [base.id]: http(baseRpcUrl),
      [mainnet.id]: http(mainnetRpcUrl),
    },
    ssr: true,
  }),
);
