import { loadConfig } from '../src/config.js';
import { createMailer } from '../src/mail.js';
const config = loadConfig();
if (config.MAIL_MODE !== 'resend' || !config.RESEND_TEST_EMAIL) throw new Error('Configure Resend test email first');
await createMailer(config).send({ to: config.RESEND_TEST_EMAIL, subject: 'MarioNet 메일 연결 테스트', text: 'MarioNet 인증 메일 발송 연결 테스트입니다. 이 메일은 계정 인증 상태를 변경하지 않습니다. 실제 인증은 앱의 인증 메일 재발송 버튼으로 진행해주세요.' });
console.log('Resend accepted the test message. Check the recipient inbox; acceptance does not guarantee delivery.');
