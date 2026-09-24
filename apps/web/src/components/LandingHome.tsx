import { useEffect, useRef } from 'react'
import { ArrowDown, ArrowUpRight, FileCode, FileJson, FileLock2, KeyRound, Monitor, ShieldCheck } from 'lucide-react'

export function LandingHome({ onSend, onReceive }: { onSend: () => void; onReceive: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    heading.current?.focus({ preventScroll: true })
  }, [])

  return (
    <>
      <section className="landing-hero" aria-labelledby="landing-title">
        <div>
          <p className="landing-eyebrow">개발 설정 파일 공유</p>
          <h1 id="landing-title" ref={heading} tabIndex={-1}>
            코드는 Git으로.
            <br />
            설정은 EnvHandoff로.
          </h1>
          <p className="landing-lead">
            저장소에 없는 .env와 개발 설정 파일,
            <br />
            필요한 것만 암호화해서 동료에게 건네세요.
          </p>
          <div className="landing-actions">
            <button type="button" className="button primary" onClick={onSend}>
              파일 보내기
              <ArrowUpRight aria-hidden="true" />
            </button>
            <button type="button" className="button" onClick={onReceive}>
              공유 파일 열기
            </button>
          </div>
          <p className="landing-small">설치나 회원가입 없이 시작하세요.</p>
        </div>
        <div
          className="landing-visual"
          role="img"
          aria-label=".env, .env.local, config/firebase.dev.json을 브라우저에서 하나의 암호화 공유 파일로 묶어 전달해요."
        >
          <div className="landing-files" aria-hidden="true">
            <div className="landing-file"><FileCode /><code>.env</code></div>
            <div className="landing-file"><FileCode /><code>.env.local</code></div>
            <div className="landing-file"><FileJson /><code>config/firebase.dev.json</code></div>
          </div>
          <div className="landing-encrypt" aria-hidden="true">
            <ArrowDown />브라우저에서 암호화
          </div>
          <div className="landing-bundle" aria-hidden="true">
            <FileLock2 />
            <div>
              <strong>하나의 .envhandoff 파일로</strong>
              <span>파일로 공유하거나, 실시간으로 전달</span>
            </div>
          </div>
        </div>
      </section>
      <ul className="landing-principles" aria-label="파일 공유 원칙">
        <li><Monitor aria-hidden="true" />이 브라우저에서 암호화</li>
        <li><KeyRound aria-hidden="true" />공유 코드는 별도로 전달</li>
        <li><ShieldCheck aria-hidden="true" />서버에 파일 보관 없음</li>
      </ul>
      <section className="landing-how" aria-labelledby="how-it-works">
        <h2 id="how-it-works" tabIndex={-1}>건네는 방법은 간단해요.</h2>
        <ol className="landing-steps">
          <li>
            <span className="landing-step-number" aria-hidden="true">01</span>
            <h3>필요한 파일만 고르기</h3>
            <p>동료에게 전달할 설정 파일과<br />Git 루트 기준 배치 경로를 확인해요.</p>
          </li>
          <li>
            <span className="landing-step-number" aria-hidden="true">02</span>
            <h3>편한 방식으로 전달하기</h3>
            <p>공유 파일을 직접 보내거나,<br />함께 접속해서 실시간으로 보내요.</p>
          </li>
          <li>
            <span className="landing-step-number" aria-hidden="true">03</span>
            <h3>코드로 열고 다운로드</h3>
            <p>받는 사람이 별도 코드로 열고,<br />원본 파일을 프로젝트에 배치해요.</p>
          </li>
        </ol>
      </section>
      <div className="landing-faq">
        <details>
          <summary>파일과 공유 코드는 어떻게 다루나요?</summary>
          <p>
            파일은 브라우저에서 암호화하고, 공유 코드는 서버로 보내지 않아요. 실시간 전달 서버는
            암호문을 중계하며 파일 저장소에 보관하지 않아요. 공유 코드는 파일·연결 링크와 다른 대화
            경로로 전달해주세요.
          </p>
        </details>
        <details>
          <summary>웹에서 내 프로젝트에 바로 적용되나요?</summary>
          <p>
            웹에서는 원본 파일을 다운로드한 뒤 직접 배치해요. 프로젝트 폴더 비교·적용·복구를
            지원하는 데스크톱 앱은 준비 중이에요.
          </p>
        </details>
      </div>
    </>
  )
}
