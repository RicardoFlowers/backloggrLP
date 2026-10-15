import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Backloggr — Sua pilha de jogos parados, organizada',
  description:
    'Backloggr importa sua Steam, mostra o que vale a pena jogar agora e transforma a culpa de comprar e nunca jogar em um plano de verdade.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
