import React, { useEffect, useState } from 'react';
import {
  Mail,
  Lock,
  Eye,
  EyeOff,
  CheckCircle2,
  AlertTriangle,
  ArrowRight,
  RefreshCw,
  ShieldCheck,
  KeyRound,
  LogIn,
  Home,
  Loader2
} from 'lucide-react';
import {
  auth,
  isSignInWithEmailLink,
  completeEmailLinkVerificationAndSetPassword,
  resendVerificationLinkForEmail,
  handleIncomingEmailVerification
} from '../firebase';
import { PasswordSetupSchema } from '../utils/validationSchemas';
import { safeGetItem } from '../utils/storage';
import { playChime } from '../data';

interface VerifyAccountPageProps {
  mode: 'check_email' | 'verify';
  initialEmail?: string;
  initialActionUrl?: string;
  language: 'en' | 'sw';
  theme: 'day' | 'night';
  onGoToLogin: (email?: string) => void;
  onBackHome: () => void;
}

export default function VerifyAccountPage({
  mode,
  initialEmail = '',
  initialActionUrl = '',
  language,
  theme,
  onGoToLogin,
  onBackHome
}: VerifyAccountPageProps) {
  const isNight = theme === 'night';

  const getInitialEmailValue = () => {
    if (initialEmail) return initialEmail.trim().toLowerCase();
    try {
      const params = new URLSearchParams(window.location.search);
      const fromUrl = params.get('verify_email') || params.get('email');
      if (fromUrl) return fromUrl.trim().toLowerCase();
      const stored = safeGetItem('digipicture_email_for_signin');
      if (stored) return stored.trim().toLowerCase();
    } catch (_) {}
    return '';
  };

  const [emailInput, setEmailInput] = useState<string>(getInitialEmailValue);
  const [newPassword, setNewPassword] = useState<string>('');
  const [confirmPassword, setConfirmPassword] = useState<string>('');
  const [showPassword, setShowPassword] = useState<boolean>(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState<boolean>(false);

  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [isResending, setIsResending] = useState<boolean>(false);
  const [resendCooldown, setResendCooldown] = useState<number>(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);

  const [verifyStage, setVerifyStage] = useState<'loading' | 'password_setup' | 'success' | 'invalid_link'>(() => {
    if (mode === 'check_email') return 'loading';
    return 'loading';
  });
  const [verifiedEmailResult, setVerifiedEmailResult] = useState<string>('');

  const actionUrl = initialActionUrl || (typeof window !== 'undefined' ? window.location.href : '');

  useEffect(() => {
    if (initialEmail && initialEmail.trim()) {
      setEmailInput(initialEmail.trim().toLowerCase());
    }
  }, [initialEmail]);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = setTimeout(() => setResendCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => clearTimeout(timer);
  }, [resendCooldown]);

  useEffect(() => {
    if (mode !== 'verify') return;

    const inspectActionLink = async () => {
      try {
        const searchParams = new URLSearchParams(window.location.search);
        const oobCode = searchParams.get('oobCode');
        const linkMode = searchParams.get('mode');
        const alreadyVerifiedParam = searchParams.get('verified');

        if (alreadyVerifiedParam === '1') {
          setVerifiedEmailResult(getInitialEmailValue());
          setVerifyStage('success');
          return;
        }

        if (isSignInWithEmailLink(auth, actionUrl)) {
          setVerifyStage('password_setup');
          return;
        }

        if (oobCode && linkMode === 'verifyEmail') {
          const verified = await handleIncomingEmailVerification(searchParams);
          if (verified) {
            setVerifiedEmailResult(verified);
            setEmailInput(verified);
            window.history.replaceState({}, document.title, '/verify?verified=1');
            setVerifyStage('success');
            playChime('sparkle');
            return;
          }
        }

        setVerifyStage('invalid_link');
      } catch (err: any) {
        console.warn('Verify link inspection error:', err);
        setErrorMessage(
          err?.message ||
            (language === 'en'
              ? 'This verification link could not be validated. Please request a fresh verification email below.'
              : 'Kiungo hiki cha uthibitisho hakikuweza kuthibitishwa. Tafadhali omba kiungo kipya hapa chini.')
        );
        setVerifyStage('invalid_link');
      }
    };

    inspectActionLink();
  }, [mode, actionUrl]);

  const passwordChecks = {
    length: newPassword.length >= 8,
    letter: /[a-zA-Z]/.test(newPassword),
    number: /[0-9]/.test(newPassword),
    symbol: /[^a-zA-Z0-9]/.test(newPassword),
    match: newPassword.length > 0 && newPassword === confirmPassword
  };

  const handleCompletePasswordSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setInfoMessage(null);

    const cleanEmail = emailInput.trim().toLowerCase();
    if (!cleanEmail || !cleanEmail.includes('@')) {
      setErrorMessage(
        language === 'en'
          ? 'Please enter the email address you used to register.'
          : 'Tafadhali weka barua pepe uliyotumia kujisajili.'
      );
      return;
    }

    const pwValidation = PasswordSetupSchema.safeParse(newPassword);
    if (!pwValidation.success) {
      setErrorMessage(pwValidation.error.issues[0]?.message || 'Invalid password format.');
      return;
    }

    if (newPassword !== confirmPassword) {
      setErrorMessage(language === 'en' ? 'Passwords do not match.' : 'Manenosiri hayafanani.');
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await completeEmailLinkVerificationAndSetPassword({
        email: cleanEmail,
        actionUrl,
        newPassword
      });

      setVerifiedEmailResult(result.email);
      setNewPassword('');
      setConfirmPassword('');
      window.history.replaceState({}, document.title, '/verify?verified=1');
      setVerifyStage('success');
      playChime('sparkle');
    } catch (err: any) {
      console.error('Failed to complete verification and password setup:', err);
      const code = err?.code || '';
      if (code === 'auth/invalid-action-code' || code === 'auth/expired-action-code') {
        setErrorMessage(
          language === 'en'
            ? 'This verification link has expired or was already used. Request a new link below.'
            : 'Kiungo hiki kimeisha muda au tayari kimetumika. Omba kiungo kipya hapa chini.'
        );
        setVerifyStage('invalid_link');
      } else if (code === 'auth/invalid-email') {
        setErrorMessage(
          language === 'en'
            ? 'The email address does not match the verification link. Please double-check your email.'
            : 'Barua pepe haifanani na kiungo cha uthibitisho.'
        );
      } else {
        setErrorMessage(
          err?.message ||
            (language === 'en'
              ? 'Could not complete account setup. Please try again.'
              : 'Imeshindwa kukamilisha usanidi wa akaunti. Tafadhali jaribu tena.')
        );
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleResendLink = async () => {
    setErrorMessage(null);
    setInfoMessage(null);
    const cleanEmail = emailInput.trim().toLowerCase();
    if (!cleanEmail || !cleanEmail.includes('@')) {
      setErrorMessage(
        language === 'en'
          ? 'Please enter a valid email address first.'
          : 'Tafadhali weka barua pepe halali kwanza.'
      );
      return;
    }

    setIsResending(true);
    try {
      await resendVerificationLinkForEmail(cleanEmail);
      setResendCooldown(30);
      setInfoMessage(
        language === 'en'
          ? `A fresh verification link has been sent to ${cleanEmail}.`
          : `Kiungo kipya cha uthibitisho kimetumwa kwa ${cleanEmail}.`
      );
      playChime('sparkle');
    } catch (err: any) {
      setErrorMessage(
        err?.message ||
          (language === 'en'
            ? 'Could not resend verification email right now.'
            : 'Imeshindwa kutuma tena barua pepe ya uthibitisho.')
      );
    } finally {
      setIsResending(false);
    }
  };

  return (
    <div
      className={`min-h-screen w-full flex flex-col items-center justify-center p-4 sm:p-6 transition-colors duration-300 ${
        isNight
          ? 'bg-gradient-to-br from-slate-950 via-slate-900 to-stone-950 text-slate-100'
          : 'bg-gradient-to-br from-amber-50 via-orange-50/70 to-yellow-50 text-amber-950'
      }`}
      id="dedicated-verification-page"
    >
      <div
        className={`w-full max-w-lg rounded-3xl border-4 shadow-2xl overflow-hidden animate-scale-up ${
          isNight ? 'bg-slate-900 border-amber-500/70' : 'bg-white border-orange-300'
        }`}
      >
        {/* Top Brand Bar */}
        <div
          className={`px-6 py-4 flex items-center justify-between border-b-4 ${
            isNight
              ? 'bg-slate-800 border-slate-700 text-amber-300'
              : 'bg-gradient-to-r from-orange-500 to-amber-500 border-orange-600 text-white'
          }`}
        >
          <div className="flex items-center gap-2.5">
            <ShieldCheck className="w-5 h-5 shrink-0" />
            <span className="font-display font-black text-base tracking-wide">
              {mode === 'check_email'
                ? (language === 'en' ? 'Verify Your Email' : 'Thibitisha Barua Pepe')
                : (language === 'en' ? 'Account Verification & Password Setup' : 'Uthibitisho na Nenosiri')}
            </span>
          </div>
          <button
            type="button"
            onClick={onBackHome}
            className={`text-xs font-bold px-2.5 py-1 rounded-xl flex items-center gap-1 cursor-pointer transition ${
              isNight
                ? 'bg-slate-700 hover:bg-slate-600 text-slate-200'
                : 'bg-white/20 hover:bg-white/30 text-white'
            }`}
            title={language === 'en' ? 'Return to Library' : 'Rudi Maktaba'}
          >
            <Home className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">{language === 'en' ? 'Library' : 'Maktaba'}</span>
          </button>
        </div>

        <div className="p-6 sm:p-8 space-y-5">
          {errorMessage && (
            <div className="p-3.5 rounded-2xl bg-rose-50 border-2 border-rose-300 text-rose-800 text-xs font-semibold flex items-start gap-2.5">
              <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
              <span>{errorMessage}</span>
            </div>
          )}

          {infoMessage && (
            <div className="p-3.5 rounded-2xl bg-emerald-50 border-2 border-emerald-300 text-emerald-800 text-xs font-semibold flex items-start gap-2.5">
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
              <span>{infoMessage}</span>
            </div>
          )}

          {/* MODE 1: CHECK YOUR EMAIL WAITING SCREEN */}
          {mode === 'check_email' && (
            <div className="text-center space-y-5" id="check-email-waiting-screen">
              <div
                className={`w-16 h-16 rounded-3xl mx-auto flex items-center justify-center border-2 shadow-md ${
                  isNight
                    ? 'bg-slate-800 border-amber-500/60 text-amber-300'
                    : 'bg-orange-50 border-orange-200 text-orange-600'
                }`}
              >
                <Mail className="w-8 h-8" />
              </div>

              <div className="space-y-2.5">
                <h1 className={`font-display font-black text-xl sm:text-2xl ${isNight ? 'text-amber-300' : 'text-gray-900'}`}>
                  {language === 'en' ? 'Check Your Email Inbox' : 'Kagua Sanduku Lako la Barua Pepe'}
                </h1>
                <p className={`text-sm leading-relaxed ${isNight ? 'text-slate-300' : 'text-gray-700'}`}>
                  {language === 'en' ? (
                    <>
                      We sent a verification link to{' '}
                      <span
                        className={`font-mono font-bold px-2 py-0.5 rounded-lg border ${
                          isNight
                            ? 'bg-slate-800 border-amber-500/40 text-amber-300'
                            : 'bg-orange-50 border-orange-200 text-orange-700'
                        }`}
                      >
                        {emailInput || 'your email address'}
                      </span>
                      . Open your email and click that link to create your password and activate your account.
                    </>
                  ) : (
                    <>
                      Tumetuma kiungo cha uthibitisho kwa{' '}
                      <span className="font-mono font-bold">{emailInput || 'barua pepe yako'}</span>. Fungua barua pepe yako na ubofye kiungo hicho ili kuunda nenosiri lako na kuwezesha akaunti yako.
                    </>
                  )}
                </p>
              </div>

              <div
                className={`p-4 rounded-2xl border text-left text-xs space-y-1.5 ${
                  isNight ? 'bg-slate-800/80 border-slate-700 text-slate-300' : 'bg-amber-50/80 border-amber-200 text-amber-900'
                }`}
              >
                <p className="font-bold">
                  {language === 'en' ? 'What happens next?' : 'Nini kinafuata?'}
                </p>
                <p>
                  {language === 'en'
                    ? '1. No account session is active yet. You can safely close this tab or keep it open.'
                    : '1. Hakuna akaunti iliyoingia bado.'}
                </p>
                <p>
                  {language === 'en'
                    ? '2. Clicking the link in your inbox (on this device or your phone) opens the password setup page.'
                    : '2. Kubofya kiungo kwenye barua pepe yako kutafungua ukurasa wa kuunda nenosiri.'}
                </p>
                <p>
                  {language === 'en'
                    ? '3. After setting your password, log in with your email and new password.'
                    : '3. Baada ya kuweka nenosiri, ingia kwa barua pepe na nenosiri lako jipya.'}
                </p>
              </div>

              <div className="flex flex-col sm:flex-row gap-3 pt-1">
                <button
                  type="button"
                  onClick={handleResendLink}
                  disabled={isResending || resendCooldown > 0}
                  className={`flex-1 py-2.5 px-4 rounded-xl font-display font-bold text-xs border-2 flex items-center justify-center gap-2 cursor-pointer transition disabled:opacity-50 ${
                    isNight
                      ? 'bg-slate-800 hover:bg-slate-700 text-amber-300 border-slate-700'
                      : 'bg-orange-50 hover:bg-orange-100 text-orange-800 border-orange-200'
                  }`}
                >
                  {isResending ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                  <span>
                    {resendCooldown > 0
                      ? (language === 'en' ? `Resend in ${resendCooldown}s` : `Tuma tena (${resendCooldown}s)`)
                      : (language === 'en' ? 'Resend Verification Link' : 'Tuma Kiungo Tena')}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => onGoToLogin(emailInput)}
                  className="flex-1 py-2.5 px-4 rounded-xl bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 text-white font-display font-bold text-xs shadow-md border-b-2 border-amber-700 flex items-center justify-center gap-2 cursor-pointer transition"
                >
                  <LogIn className="w-4 h-4" />
                  <span>{language === 'en' ? 'Back to Login' : 'Rudi Kwenye Kuingia'}</span>
                </button>
              </div>

              <p className={`text-[11px] ${isNight ? 'text-slate-400' : 'text-gray-500'}`}>
                {language === 'en'
                  ? "Didn't receive it? Check your spam or promotions folder."
                  : 'Hujaona barua pepe? Angalia folda ya spam.'}
              </p>
            </div>
          )}

          {/* MODE 2: /verify LOADING */}
          {mode === 'verify' && verifyStage === 'loading' && (
            <div className="py-10 text-center space-y-3">
              <Loader2 className="w-10 h-10 text-orange-500 animate-spin mx-auto" />
              <p className={`text-sm font-semibold ${isNight ? 'text-slate-300' : 'text-gray-700'}`}>
                {language === 'en' ? 'Validating verification link...' : 'Inathibitisha kiungo chako...'}
              </p>
            </div>
          )}

          {/* MODE 2: /verify PASSWORD SETUP FORM */}
          {mode === 'verify' && verifyStage === 'password_setup' && (
            <form onSubmit={handleCompletePasswordSetup} className="space-y-4" id="verify-password-setup-form">
              <div className="text-center space-y-2">
                <div
                  className={`w-14 h-14 rounded-2xl mx-auto flex items-center justify-center border-2 shadow-sm ${
                    isNight
                      ? 'bg-slate-800 border-amber-500/60 text-amber-300'
                      : 'bg-orange-50 border-orange-200 text-orange-600'
                  }`}
                >
                  <KeyRound className="w-7 h-7" />
                </div>
                <h1 className={`font-display font-black text-xl ${isNight ? 'text-amber-300' : 'text-gray-900'}`}>
                  {language === 'en' ? 'Set Your Account Password' : 'Weka Nenosiri la Akaunti Yako'}
                </h1>
                <p className={`text-xs leading-relaxed ${isNight ? 'text-slate-300' : 'text-gray-600'}`}>
                  {language === 'en'
                    ? 'Confirm your email and create a secure password to activate your verified account.'
                    : 'Thibitisha barua pepe yako na uunde nenosiri salama ili kuwezesha akaunti yako.'}
                </p>
              </div>

              <div>
                <label className={`block text-xs font-display font-bold mb-1 ${isNight ? 'text-amber-200' : 'text-amber-950'}`}>
                  {language === 'en' ? 'Email Address' : 'Anwani ya Barua Pepe'}
                </label>
                <div className="relative">
                  <Mail className="w-4 h-4 text-orange-400 absolute left-3 top-3" />
                  <input
                    type="email"
                    required
                    value={emailInput}
                    onChange={(e) => setEmailInput(e.target.value)}
                    placeholder="youremail@gmail.com"
                    className={`w-full pl-9 pr-3 py-2.5 text-xs rounded-xl border-2 focus:outline-none font-medium ${
                      isNight
                        ? 'bg-slate-800 text-slate-100 border-slate-700 focus:border-amber-500'
                        : 'bg-orange-50/20 text-gray-900 border-orange-200 focus:border-orange-500'
                    }`}
                    id="verify-email-input"
                  />
                </div>
              </div>

              <div>
                <label className={`block text-xs font-display font-bold mb-1 ${isNight ? 'text-amber-200' : 'text-amber-950'}`}>
                  {language === 'en' ? 'Create Password' : 'Unda Nenosiri'}
                </label>
                <div className="relative">
                  <Lock className="w-4 h-4 text-orange-400 absolute left-3 top-3" />
                  <input
                    type={showPassword ? 'text' : 'password'}
                    required
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="••••••••"
                    className={`w-full pl-9 pr-10 py-2.5 text-xs rounded-xl border-2 focus:outline-none font-medium ${
                      isNight
                        ? 'bg-slate-800 text-slate-100 border-slate-700 focus:border-amber-500'
                        : 'bg-orange-50/20 text-gray-900 border-orange-200 focus:border-orange-500'
                    }`}
                    id="verify-new-password-input"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((s) => !s)}
                    className="absolute right-3 top-2.5 text-gray-400 hover:text-orange-500 cursor-pointer"
                    aria-label="Toggle password visibility"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <div>
                <label className={`block text-xs font-display font-bold mb-1 ${isNight ? 'text-amber-200' : 'text-amber-950'}`}>
                  {language === 'en' ? 'Confirm Password' : 'Thibitisha Nenosiri'}
                </label>
                <div className="relative">
                  <Lock className="w-4 h-4 text-orange-400 absolute left-3 top-3" />
                  <input
                    type={showConfirmPassword ? 'text' : 'password'}
                    required
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="••••••••"
                    className={`w-full pl-9 pr-10 py-2.5 text-xs rounded-xl border-2 focus:outline-none font-medium ${
                      isNight
                        ? 'bg-slate-800 text-slate-100 border-slate-700 focus:border-amber-500'
                        : 'bg-orange-50/20 text-gray-900 border-orange-200 focus:border-orange-500'
                    }`}
                    id="verify-confirm-password-input"
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirmPassword((s) => !s)}
                    className="absolute right-3 top-2.5 text-gray-400 hover:text-orange-500 cursor-pointer"
                    aria-label="Toggle confirm password visibility"
                  >
                    {showConfirmPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {/* Password Strength Checklist */}
              <div
                className={`p-3 rounded-2xl border text-[11px] grid grid-cols-2 gap-1.5 ${
                  isNight ? 'bg-slate-800/80 border-slate-700 text-slate-300' : 'bg-amber-50/80 border-amber-200 text-amber-950'
                }`}
              >
                <span className={passwordChecks.length ? 'text-emerald-600 font-bold' : ''}>
                  {passwordChecks.length ? '✓' : '•'} {language === 'en' ? '8+ characters' : 'Herufi 8+'}
                </span>
                <span className={passwordChecks.letter ? 'text-emerald-600 font-bold' : ''}>
                  {passwordChecks.letter ? '✓' : '•'} {language === 'en' ? 'Letters (a-z, A-Z)' : 'Herufi (a-z, A-Z)'}
                </span>
                <span className={passwordChecks.number ? 'text-emerald-600 font-bold' : ''}>
                  {passwordChecks.number ? '✓' : '•'} {language === 'en' ? 'Number (0-9)' : 'Namba (0-9)'}
                </span>
                <span className={passwordChecks.symbol ? 'text-emerald-600 font-bold' : ''}>
                  {passwordChecks.symbol ? '✓' : '•'} {language === 'en' ? 'Symbol (!@#$)' : 'Alama (!@#$)'}
                </span>
                <span className={`col-span-2 ${passwordChecks.match ? 'text-emerald-600 font-bold' : ''}`}>
                  {passwordChecks.match ? '✓' : '•'} {language === 'en' ? 'Passwords match' : 'Manenosiri yanafanana'}
                </span>
              </div>

              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full py-3 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 disabled:opacity-60 text-white font-display font-bold text-sm rounded-xl shadow-md border-b-3 border-amber-700 active:translate-y-0.5 cursor-pointer transition flex items-center justify-center gap-2"
                id="verify-submit-password-btn"
              >
                {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
                <span>
                  {isSubmitting
                    ? (language === 'en' ? 'Creating Password & Verifying...' : 'Inaunda Nenosiri...')
                    : (language === 'en' ? 'Set Password & Verify Account' : 'Weka Nenosiri na Thibitisha')}
                </span>
              </button>
            </form>
          )}

          {/* MODE 2: /verify SUCCESS -> ENFORCED EXPLICIT LOGIN */}
          {mode === 'verify' && verifyStage === 'success' && (
            <div className="text-center space-y-5 py-2" id="verify-success-screen">
              <div className="w-16 h-16 rounded-3xl mx-auto flex items-center justify-center bg-emerald-100 border-2 border-emerald-400 text-emerald-600 shadow-md">
                <CheckCircle2 className="w-9 h-9" />
              </div>

              <div className="space-y-2">
                <h1 className={`font-display font-black text-xl sm:text-2xl ${isNight ? 'text-emerald-300' : 'text-emerald-900'}`}>
                  {language === 'en' ? 'Email Verified & Account Ready!' : 'Barua Pepe Imethibitishwa!'}
                </h1>
                <p className={`text-sm leading-relaxed ${isNight ? 'text-slate-300' : 'text-gray-700'}`}>
                  {language === 'en' ? (
                    <>
                      Your email{' '}
                      {verifiedEmailResult && (
                        <span className="font-mono font-bold text-orange-600">{verifiedEmailResult}</span>
                      )}{' '}
                      is now verified and saved. Please log in with your email and password to open your studio.
                    </>
                  ) : (
                    <>
                      Barua pepe yako imethibitishwa kikamilifu. Tafadhali ingia kwa barua pepe na nenosiri lako ili kufungua studio yako.
                    </>
                  )}
                </p>
              </div>

              <button
                type="button"
                onClick={() => onGoToLogin(verifiedEmailResult || emailInput)}
                className="w-full py-3.5 px-6 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 text-white font-display font-extrabold text-sm sm:text-base rounded-2xl shadow-md border-b-4 border-orange-700 active:translate-y-0.5 cursor-pointer transition flex items-center justify-center gap-2"
                id="verify-go-to-login-btn"
              >
                <LogIn className="w-5 h-5" />
                <span>{language === 'en' ? 'Go to Login' : 'Nenda Kwenye Kuingia'}</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* MODE 2: /verify EXPIRED OR INVALID LINK */}
          {mode === 'verify' && verifyStage === 'invalid_link' && (
            <div className="space-y-4 text-center" id="verify-invalid-link-screen">
              <div className="w-14 h-14 rounded-2xl mx-auto flex items-center justify-center bg-amber-100 border-2 border-amber-300 text-amber-700">
                <AlertTriangle className="w-7 h-7" />
              </div>
              <div className="space-y-1.5">
                <h1 className={`font-display font-black text-lg ${isNight ? 'text-amber-300' : 'text-gray-900'}`}>
                  {language === 'en' ? 'Verification Link Expired or Missing' : 'Kiungo Kimeisha Muda au Hakipo'}
                </h1>
                <p className={`text-xs leading-relaxed ${isNight ? 'text-slate-300' : 'text-gray-600'}`}>
                  {language === 'en'
                    ? 'Enter your email below to receive a fresh verification & password-setup link, or go to login if you already verified your account.'
                    : 'Weka barua pepe yako hapa chini kupokea kiungo kipya cha uthibitisho, au nenda kwenye kuingia ikiwa tayari umethibitisha.'}
                </p>
              </div>

              <div className="relative text-left">
                <Mail className="w-4 h-4 text-orange-400 absolute left-3 top-3" />
                <input
                  type="email"
                  value={emailInput}
                  onChange={(e) => setEmailInput(e.target.value)}
                  placeholder="youremail@gmail.com"
                  className={`w-full pl-9 pr-3 py-2.5 text-xs rounded-xl border-2 focus:outline-none font-medium ${
                    isNight
                      ? 'bg-slate-800 text-slate-100 border-slate-700 focus:border-amber-500'
                      : 'bg-orange-50/20 text-gray-900 border-orange-200 focus:border-orange-500'
                  }`}
                />
              </div>

              <div className="flex flex-col sm:flex-row gap-3">
                <button
                  type="button"
                  onClick={handleResendLink}
                  disabled={isResending || resendCooldown > 0}
                  className={`flex-1 py-2.5 px-4 rounded-xl font-display font-bold text-xs border-2 flex items-center justify-center gap-2 cursor-pointer transition disabled:opacity-50 ${
                    isNight
                      ? 'bg-slate-800 hover:bg-slate-700 text-amber-300 border-slate-700'
                      : 'bg-orange-50 hover:bg-orange-100 text-orange-800 border-orange-200'
                  }`}
                >
                  {isResending ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                  <span>
                    {resendCooldown > 0
                      ? (language === 'en' ? `Resend in ${resendCooldown}s` : `Tuma tena (${resendCooldown}s)`)
                      : (language === 'en' ? 'Send New Link' : 'Tuma Kiungo Kipya')}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => onGoToLogin(emailInput)}
                  className="flex-1 py-2.5 px-4 rounded-xl bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 text-white font-display font-bold text-xs shadow-md border-b-2 border-amber-700 flex items-center justify-center gap-2 cursor-pointer transition"
                >
                  <LogIn className="w-4 h-4" />
                  <span>{language === 'en' ? 'Go to Login' : 'Nenda Kwenye Kuingia'}</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
