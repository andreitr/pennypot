import { getDefaultConfig } from "connectkit";
import { createConfig, http } from "wagmi";
import { base } from "wagmi/chains";

// ConnectKit's getDefaultConfig wires up a sensible default wallet set (Injected,
// Coinbase Wallet, WalletConnect, Safe) plus storage + ssr glue. We just pass it
// through createConfig.
//
// WalletConnect requires a free project id from https://cloud.walletconnect.com.
// If unset, Injected + Coinbase Wallet still work; WalletConnect-based wallets
// will fail to connect.
const projectId =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "pennypot-dev-placeholder";

export const wagmiConfig = createConfig(
  getDefaultConfig({
    appName: "PennyPot",
    appDescription: "1¢ shares of Megapot lottery tickets on Base",
    appUrl: "https://github.com/andreitr/pennypot",
    walletConnectProjectId: projectId,
    chains: [base],
    transports: {
      [base.id]: http(process.env.NEXT_PUBLIC_BASE_RPC_URL),
    },
    ssr: true,
  }),
);
