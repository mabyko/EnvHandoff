import { useEffect, useRef } from 'react'
import { ArrowDown, ArrowRight, Check, FileCode, FileLock2, KeyRound, Monitor, ShieldCheck } from 'lucide-react'

export function LandingHome({ onSend, onReceive }: { onSend: () => void; onReceive: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    heading.current?.focus({ preventScroll: true })
  }, [])

  return (
    <>
      <section className="landing-hero" aria-labelledby="landing-title">
        <div>
          <p className="landing-eyebrow"><ShieldCheck aria-hidden="true" />설치 없이 쓰는 개발 설정 공유</p>
          <h1 id="landing-title" ref={heading} tabIndex={-1}>
            .env를 건네고,
            <br />
            <span>함께 시작하세요.</span>
          </h1>
          <p className="landing-lead">
            Git에 없는 설정 파일을 동료에게.
            <br />
            가입 없이, 브라우저에서 암호화해 전달해요.
          </p>
          <div className="landing-actions">
            <button type="button" className="button primary" onClick={onSend}>
              설정 파일 보내기
              <ArrowRight aria-hidden="true" />
            </button>
            <button type="button" className="text-button" onClick={onReceive}>
              받은 공유 파일 열기
            </button>
          </div>
          <p className="landing-small">파일을 고르는 것부터 시작하면 돼요.</p>
        </div>
        <div
          className="handoff-preview"
          role="img"
          aria-label="내 프로젝트의 .env를 브라우저에서 암호화해서 전달하면, 동료가 코드로 열고 원본 파일을 다운로드해요."
        >
          <div aria-hidden="true">
            <div className="preview-toolbar"><span>공유 미리보기</span><span className="preview-badge">예시</span></div>
            <div className="preview-file">
              <p className="preview-project">my-project <span>/ development</span></p>
              <div className="preview-file-row">
                <span className="file-emblem"><FileCode /></span>
                <div><strong>.env</strong><span>원본 파일 그대로</span></div>
                <Check />
              </div>
              <pre>{'DATABASE_URL=••••••••\nAPI_KEY=••••••••'}</pre>
            </div>
            <div className="preview-encrypt"><ArrowDown /><span>이 브라우저에서 암호화</span></div>
            <div className="preview-delivery"><FileLock2 /><div><strong>동료에게 건넬 준비</strong><span>공유 파일 + 별도 코드</span></div><ShieldCheck /></div>
          </div>
        </div>
      </section>
      <section className="landing-how" aria-labelledby="how-it-works">
        <p className="section-eyebrow">HOW IT WORKS</p>
        <h2 id="how-it-works" tabIndex={-1}>한 번의 전달, 세 단계.</h2>
        <ol className="landing-steps">
          <li>
            <span className="landing-step-number" aria-hidden="true"><FileCode /></span>
            <h3>보낼 .env 고르기</h3>
            <p>내 프로젝트에서 동료에게 필요한<br />설정 파일을 선택해요.</p>
          </li>
          <li>
            <span className="landing-step-number" aria-hidden="true"><FileLock2 /></span>
            <h3>암호화된 파일 보내기</h3>
            <p>공유 파일은 메신저 등으로 보내고,<br />공유 코드는 다른 대화 경로로 전달해요.</p>
          </li>
          <li>
            <span className="landing-step-number" aria-hidden="true"><Check /></span>
            <h3>동료가 받아서 배치하기</h3>
            <p>동료가 코드로 열고 원본을 다운로드해,<br />안내된 경로에 직접 넣어요.</p>
          </li>
        </ol>
      </section>
      <ul className="landing-principles" aria-label="무료 파일 공유 원칙">
        <li><Monitor aria-hidden="true" />브라우저에서 암호화</li>
        <li><KeyRound aria-hidden="true" />공유 코드는 별도로 전달</li>
        <li><ShieldCheck aria-hidden="true" />무료 공유는 서버에 파일 보관 없음</li>
      </ul>
      <section className="landing-pro" aria-labelledby="landing-pro-title">
        <div>
          <p className="section-eyebrow">EnvHandoff Pro · 무료 초대 베타</p>
          <h2 id="landing-pro-title">팀에서 자주 공유하나요?</h2>
          <p>팀의 프로젝트·환경별로 설정 파일을 요청하고 승인하세요.</p>
          <p className="help">GitHub 로그인과 초대가 필요해요. 현재 신규 파일 전달은 점검 중이에요.</p>
        </div>
        <a className="button" href="/pro">Pro 살펴보기<ArrowRight aria-hidden="true" /></a>
      </section>
      <section className="landing-faq" aria-labelledby="faq-title">
        <div className="faq-intro"><p className="section-eyebrow">GOOD TO KNOW</p><h2 id="faq-title">궁금한 것만<br />살펴보세요.</h2><p>지금은 파일 하나로 시작해도 충분해요.</p></div>
        <div className="faq-questions">
        <details>
          <summary>.env 외에 다른 설정 파일도 보낼 수 있나요?</summary>
          <p>.env.local이나 JSON 등 필요한 개발 설정 파일을 함께 고를 수 있어요. 두 사람이 함께 접속해 있다면 보내기 화면에서 실시간 전달을 선택할 수도 있어요.</p>
        </details>
        <details>
          <summary>무료 공유에서 파일과 코드는 어떻게 다루나요?</summary>
          <p>
            파일은 브라우저에서 암호화하고, 공유 코드는 서버로 보내지 않아요. 실시간 전달 서버는
            암호문을 중계하며 파일 저장소에 보관하지 않아요. 공유 코드는 파일·연결 링크와 다른 대화
            경로로 전달해주세요.
          </p>
        </details>
        <details>
          <summary>웹에서 내 프로젝트에 바로 적용되나요?</summary>
          <p>
            웹에서는 원본 파일을 다운로드한 뒤, 안내된 경로에 직접 배치해요.
            프로젝트의 기존 파일을 자동으로 바꾸지는 않아요.
          </p>
        </details>
        </div>
      </section>
    </>
  )
}
