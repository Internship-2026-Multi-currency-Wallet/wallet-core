// Client branches replace this file so shared templates stay brand-independent.
export interface Brand {
  name: string;
  senderName: string;
  logoUrl: string;
  palette: { primary: string; secondary: string; background: string; text: string };
  fontFamily: string;
}

export const brand = {
  name: 'Demo Wallet',
  senderName: 'Demo Wallet',
  logoUrl: 'https://staging.wallet.shatori.com/brand/logo.svg',
  palette: { primary: '#4F46E5', secondary: '#0EA5E9', background: '#F8FAFC', text: '#1E1B4B' },
  fontFamily: "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
} as const satisfies Brand;
