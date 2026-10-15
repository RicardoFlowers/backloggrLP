// Home: por enquanto só a nav e o hero da LP, portados do index.html.
// Sem 'use client' porque ainda não tem estado nem clique: é só HTML renderizado no servidor.
export default function Home() {
  return (
    <>
      <nav>
        <div className="logo">
          backlog<span>gr</span>
          <span className="cursor"></span>
        </div>
        <a href="#waitlist" className="cta-small">
          &gt; entrar na lista
        </a>
      </nav>

      <header className="hero">
        <div className="terminal-line">
          <span className="prompt">$</span>checando sua biblioteca de jogos<span className="cursor2"></span>
        </div>
        <h1>
          Você tem <em>200 jogos</em> parados na sua biblioteca. Vamos organizar isso.
        </h1>
        <p className="sub">
          Backloggr importa sua Steam, mostra o que vale a pena jogar agora e transforma aquela culpa de comprar e
          nunca jogar em um plano de verdade.
        </p>
        <a href="#calc" className="btn-primary">
          &gt; calcular meu backlog
        </a>
        <a href="#waitlist" className="btn-ghost">
          quero ser avisado
        </a>
      </header>
    </>
  );
}
