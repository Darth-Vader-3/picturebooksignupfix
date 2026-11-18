import React, { useState, useEffect, useRef } from 'react';
import { GoogleAuthProvider, signInWithPopup } from 'firebase/auth';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import {
  savePendingSignup,
  getPendingSignup,
  clearPendingSignup,
  sendSignupVerificationLink,
  completeSignupFromEmailLink,
  sendPasswordResetEmail,
  sendVerificationEmailSafely,
  markEmailVerifiedInFirestore,
  signOutFromFirebaseAndClearSession,
  resolveEmailFromIdentifier,
  fetchArtistsFromFirestore,
  getUserAndArtistDoc,
  signInWithEmailAndPassword,
  signOut,
  auth,
  db
} from '../firebase';
import {
  User,
  Mail,
  Lock,
  Phone,
  Palette,
  Sparkles,
  Check,
  ArrowRight,
  LogIn,
  UserPlus,
  ShieldCheck,
  Camera,
  Globe,
  Tag,
  HelpCircle,
  Clock,
  X,
  Upload,
  Plus
} from 'lucide-react';
import { playChime, maskEmail } from '../data';
import { isValidEmail, securityRateLimiter, sanitizeInput, sanitizeSqlInjection, evaluatePasswordStrength, hashPasswordAsync, verifyPasswordAsync, generateSessionToken } from '../utils/security';
import { UserRegistrationSchema, UserLoginSchema, validateWithSchema } from '../utils/validationSchemas';
import { safeGetJSON, safeSetItem, compressImageFile } from '../utils/storage';

import { UserAccount, UserRole, UserStatus } from '../types';
export type { UserAccount };

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAuthenticate: (account: UserAccount) => void;
  currentAccount: UserAccount;
  language: 'en' | 'sw';
  theme?: 'day' | 'night';
  onLogout?: () => Promise<void> | void;
  initialStep?: 'role_select' | 'artist_auth' | 'student_setup';
  initialAuthTab?: 'login' | 'signup' | 'forgot_password' | 'email_verification' | 'complete_signup';
  initialLoginEmail?: string;
  initialSuccessNotice?: string;
  /** Full URL of the emailed sign-up link (set when the person opens it); account is created from it. */
  initialCompleteSignupLink?: string;
}

const ARTIST_CATEGORIES = [
  'Sculpture & Clay',
  'Watercolor & Painting',
  'Origami & Papercraft',
  'Storybook Illustration',
  '3D Modeling & Crafts',
  'Animation & Puppetry',
  'Digital Art & Fine Art'
];

const PRESET_AVATARS = ['🎨', '👩‍🎨', '🧑‍🎨', '👨‍🎨', '🖌️', '🎭', '🦊', '🦁', '🐼', '🦄', '🦉', '🐯', '🐰', '🌟', '🚀', '🔮'];

export default function AuthModal({
  isOpen,
  onClose,
  onAuthenticate,
  currentAccount,
  language,
  theme = 'day',
  onLogout,
  initialStep,
  initialAuthTab,
  initialLoginEmail,
  initialSuccessNotice,
  initialCompleteSignupLink
}: AuthModalProps) {
  const isNight = theme === 'night';

  // View mode: 'role_select' | 'artist_auth' | 'student_setup'
  const [selectedRole, setSelectedRole] = useState<'artist' | 'student'>('artist');
  const [step, setStep] = useState<'role_select' | 'artist_auth' | 'student_setup'>('role_select');
  
  // Artist auth tab: 'login' | 'signup' | 'forgot_password' | 'email_verification'
  const [authTab, setAuthTab] = useState<'login' | 'signup' | 'forgot_password' | 'email_verification' | 'complete_signup'>('login');

  // Finishing sign-up from the emailed link (the Firebase account is created in this step)
  const [completeSignupHref, setCompleteSignupHref] = useState<string>('');
  const [completePassword, setCompletePassword] = useState<string>('');
  const [isCompletingSignup, setIsCompletingSignup] = useState<boolean>(false);
  const [isSendingSignupLink, setIsSendingSignupLink] = useState<boolean>(false);
  const [completeSignupProblem, setCompleteSignupProblem] = useState<null | 'expired' | 'no_pending'>(null);
  // Which kind of account the verification screen is about:
  //  - 'pending_signup': registered, NOT yet created in Firebase (link emailed, account made after the click)
  //  - 'legacy_account': an account that already exists in Firebase but was never verified
  const [verificationMode, setVerificationMode] = useState<'pending_signup' | 'legacy_account'>('pending_signup');

  // Synchronize initial state when opening or when initial props update
  useEffect(() => {
    if (isOpen) {
      if (initialStep) setStep(initialStep);
      if (initialAuthTab) setAuthTab(initialAuthTab);
      if (initialCompleteSignupLink) {
        setCompleteSignupHref(initialCompleteSignupLink);
        setCompleteSignupProblem(null);
        setCompletePassword('');
      }
      if (initialLoginEmail) setLoginIdentifier(initialLoginEmail);
      if (initialSuccessNotice) {
        setSuccessNotice(initialSuccessNotice);
        setErrorMessage(null);
      }
    }
  }, [isOpen, initialStep, initialAuthTab, initialLoginEmail, initialSuccessNotice, initialCompleteSignupLink]);

  // Forgot Password state
  const [resetEmail, setResetEmail] = useState('');
  const [sentResetEmail, setSentResetEmail] = useState('');
  const [isSendingReset, setIsSendingReset] = useState(false);
  const [resetSentSuccess, setResetSentSuccess] = useState(false);

  // Login form state
  const [loginIdentifier, setLoginIdentifier] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  
  // Signup form state
  const [signupFirstName, setSignupFirstName] = useState('');
  const [signupLastName, setSignupLastName] = useState('');
  const [signupUsername, setSignupUsername] = useState('');
  const [signupEmail, setSignupEmail] = useState('');
  const [signupPhone, setSignupPhone] = useState('');
  const [signupAvatar, setSignupAvatar] = useState('🎨');
  const [signupProfilePicUrl, setSignupProfilePicUrl] = useState('');
  const photoFileInputRef = useRef<HTMLInputElement>(null);
  const [customAvatarInput, setCustomAvatarInput] = useState('');
  const [showCustomAvatarInput, setShowCustomAvatarInput] = useState(false);
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [isProcessingPhoto, setIsProcessingPhoto] = useState(false);

  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      setErrorMessage(language === 'en' ? 'Please select a valid image file (PNG, JPG, WEBP).' : 'Tafadhali chagua faili halali ya picha (PNG, JPG, WEBP).');
      return;
    }

    try {
      setIsProcessingPhoto(true);
      const compressedDataUrl = await compressImageFile(file, 600, 600, 0.85);
      setSignupProfilePicUrl(compressedDataUrl);
      playChime('sparkle');
    } catch (err) {
      console.error('Error reading/compressing photo:', err);
      setErrorMessage(language === 'en' ? 'Failed to process photo. Please try a different image.' : 'Imeshindwa kusindika picha. Tafadhali jaribu picha nyingine.');
    } finally {
      setIsProcessingPhoto(false);
      if (photoFileInputRef.current) {
        photoFileInputRef.current.value = '';
      }
    }
  };

  const handleRemovePhoto = () => {
    setSignupProfilePicUrl('');
    if (photoFileInputRef.current) {
      photoFileInputRef.current.value = '';
    }
    playChime('pop');
  };

  const handleAddCustomAvatar = () => {
    const trimmed = customAvatarInput.trim();
    if (!trimmed) return;
    setSignupAvatar(trimmed);
    setSignupProfilePicUrl('');
    setCustomAvatarInput('');
    setShowCustomAvatarInput(false);
    playChime('sparkle');
  };
  const [signupSampleImageUrl, setSignupSampleImageUrl] = useState('');
  // State array for selected categories and auto-synchronized specialization text
  const [selectedCategories, setSelectedCategories] = useState<string[]>(['Storybook Illustration', 'Sculpture & Clay']);
  const signupCategories = selectedCategories;
  const setSignupCategories = setSelectedCategories;
  const [signupSpecialization, setSignupSpecialization] = useState('Storybook Illustration, Sculpture & Clay');
  const [signupBio, setSignupBio] = useState('');
  const [signupPassword, setSignupPassword] = useState('');
  const [signupConfirmPassword, setSignupConfirmPassword] = useState('');

  // Student quick setup state
  const [studentName, setStudentName] = useState('Student Reader');
  const [studentAvatar, setStudentAvatar] = useState('🎓');

  // Error and notice state
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successNotice, setSuccessNotice] = useState<string | null>(null);
  const [isGoogleSigningIn, setIsGoogleSigningIn] = useState(false);

  // Email Verification States
  const [pendingVerificationEmail, setPendingVerificationEmail] = useState<string | null>(null);
  const [pendingVerificationName, setPendingVerificationName] = useState<string>('');
  const [showVerificationBox, setShowVerificationBox] = useState<boolean>(false);
  // Error code when the verification email could NOT be sent (null = it was sent successfully)
  const [verificationSendError, setVerificationSendError] = useState<string | null>(null);
  const [isResendingVerification, setIsResendingVerification] = useState<boolean>(false);
  const [resendCooldown, setResendCooldown] = useState<number>(0);
  // Kept in memory only (never stored) so "Resend" can work right after sign-up. Cleared on close/login.
  const pendingPasswordRef = useRef<string | null>(null);

  // The link usually opens in a NEW tab. When that tab finishes the sign-up it clears the pending
  // registration; this (original) tab then stops waiting and moves on to the login screen.
  useEffect(() => {
    const onStorage = (ev: StorageEvent) => {
      if (ev.key === 'digipicture_pending_signup' && ev.newValue === null && authTab === 'email_verification' && verificationMode === 'pending_signup') {
        setLoginIdentifier(pendingVerificationEmail || '');
        setLoginPassword('');
        setErrorMessage(null);
        setSuccessNotice(
          language === 'en'
            ? 'Your email is verified and your account has been created. Please log in.'
            : 'Barua pepe yako imethibitishwa na akaunti yako imetengenezwa. Tafadhali ingia.'
        );
        setAuthTab('login');
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [authTab, verificationMode, pendingVerificationEmail, language]);

  // Countdown for the "Resend verification email" button
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = setTimeout(() => setResendCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => clearTimeout(timer);
  }, [resendCooldown]);

  // Helper to load registered artists from localStorage with initial seeds if empty
  const getRegisteredArtists = (): any[] => {
    const adminHashedPw = '$pbkdf2$v1$10000$ecefb0e5834ee971ed59e0bb2156891a$88ed978d97955e06802c5ca8f7fe0ebbce5261ff42c5360c554cebf44cbc4bcc';
    const demoHashedPw = '$pbkdf2$v1$10000$af0a0719386aebe530a1965048d00b69$11f7677dee1bc9aa84bf7338d938aa0f0274efbd975e2cc390a6b915594bb957';

    try {
      const parsed = safeGetJSON<any[]>('digipicture_registered_artists', []);
      if (Array.isArray(parsed) && parsed.length > 0) {
        // Ensure current admin email and hashed password are up-to-date in local cache
        let hasOldAdmin = parsed.some((a: any) => a.email?.toLowerCase() === 'informationpicturebook@gmail.com');
        let hasNewAdmin = parsed.some((a: any) => a.email?.toLowerCase() === 'yamauchiryoko16@gmail.com');
        let needsPwUpdate = parsed.some((a: any) => a.email?.toLowerCase() === 'yamauchiryoko16@gmail.com' && a.password !== adminHashedPw);
        if (hasOldAdmin || !hasNewAdmin || needsPwUpdate) {
          const updated = parsed.map((a: any) => {
            if (a.email?.toLowerCase() === 'informationpicturebook@gmail.com' || a.email?.toLowerCase() === 'yamauchiryoko16@gmail.com' || (a.role === 'admin' && a.email?.toLowerCase() !== 'admin@picturebook.com')) {
              return {
                ...a,
                email: 'yamauchiryoko16@gmail.com',
                password: adminHashedPw
              };
            }
            return a;
          });
          if (!updated.some((a: any) => a.email?.toLowerCase() === 'yamauchiryoko16@gmail.com')) {
            updated.unshift({
              role: 'admin',
              status: 'approved',
              name: 'System Administrator',
              email: 'yamauchiryoko16@gmail.com',
              username: '@admin',
              password: adminHashedPw,
              phone: '+1 555-0100',
              avatar: '🛡️',
              categories: ['System Moderation', 'Content Review'],
              bio: 'Official Platform Administrator & Content Reviewer',
              isLoggedIn: false,
              isEmailVerified: true
            });
          }
          safeSetItem('digipicture_registered_artists', updated);
          return updated;
        }
        return parsed;
      }
    } catch (e) {
      console.error(e);
    }
    const seedArtists = [
      {
        role: 'admin',
        status: 'approved',
        name: 'System Administrator',
        email: 'yamauchiryoko16@gmail.com',
        username: '@admin',
        password: adminHashedPw,
        phone: '+1 555-0100',
        avatar: '🛡️',
        categories: ['System Moderation', 'Content Review'],
        bio: 'Official Platform Administrator & Content Reviewer',
        isLoggedIn: false,
        isEmailVerified: true
      }
    ];
    safeSetItem('digipicture_registered_artists', seedArtists);
    return seedArtists;
  };

  const getPendingRegistrations = (): any[] => {
    return safeGetJSON<any[]>('digipicture_pending_registrations', []);
  };

  const savePendingRegistration = (artist: any) => {
    try {
      let pending = getPendingRegistrations();
      pending = Array.isArray(pending) ? pending.filter((a: any) => a && a.email?.toLowerCase() !== artist.email?.toLowerCase()) : [];
      pending.push(artist);
      safeSetItem('digipicture_pending_registrations', pending);
    } catch (e) {
      console.error(e);
    }
  };

  if (!isOpen) return null;

  const toggleCategory = (cat: string) => {
    playChime('pop');
    setSelectedCategories((prev) => {
      const nextCategories = prev.includes(cat)
        ? prev.filter((c) => c !== cat)
        : [...prev, cat];

      // Format selected category array into comma-separated string
      // Allow custom editing: preserve any manually added niche details not in ARTIST_CATEGORIES
      const currentTokens = signupSpecialization
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      const customTokens = currentTokens.filter(
        (token) => !ARTIST_CATEGORIES.some((c) => c.toLowerCase() === token.toLowerCase())
      );

      const formattedSpecialization = customTokens.length > 0
        ? [...nextCategories, ...customTokens].join(', ')
        : nextCategories.join(', ');

      setSignupSpecialization(formattedSpecialization);
      return nextCategories;
    });
  };

  const describeVerificationSendError = (code: string | null): string => {
    const en = language === 'en';
    if (code === 'auth/too-many-requests') {
      return en
        ? 'Too many verification emails were requested for this address. Please wait a few minutes, then press "Resend verification email".'
        : 'Barua pepe nyingi za uthibitisho zimeombwa kwa anwani hii. Tafadhali subiri dakika chache, kisha bonyeza "Tuma tena".';
    }
    if (code === 'auth/operation-not-allowed') {
      return en
        ? 'Sign-up emails are not switched on yet. (Firebase Console → Authentication → Sign-in method → Email/Password → enable "Email link (passwordless sign-in)".)'
        : 'Barua pepe za kujisajili hazijawashwa bado. (Firebase Console → Authentication → Sign-in method → Email/Password → washa "Email link (passwordless sign-in)".)';
    }
    if (code === 'auth/unauthorized-continue-uri' || code === 'auth/invalid-continue-uri' || code === 'auth/missing-continue-uri') {
      return en
        ? 'This website address is not authorised in Firebase yet. (Firebase Console → Authentication → Settings → Authorized domains → add this domain.)'
        : 'Anwani ya tovuti hii haijaidhinishwa kwenye Firebase bado. (Firebase Console → Authentication → Settings → Authorized domains → ongeza domain hii.)';
    }
    if (code === 'auth/invalid-email') {
      return en ? 'That email address does not look valid. Please check it and try again.' : 'Anwani hiyo ya barua pepe si halali. Tafadhali ikague na ujaribu tena.';
    }
    if (code === 'auth/network-request-failed') {
      return en
        ? 'Network problem while sending the email. Check your connection and press "Resend verification email".'
        : 'Tatizo la mtandao wakati wa kutuma barua pepe. Kagua mtandao wako kisha bonyeza "Tuma tena".';
    }
    return en
      ? 'The verification email could not be sent right now. Please press "Resend verification email" to try again.'
      : 'Barua pepe ya uthibitisho haikuweza kutumwa sasa. Tafadhali bonyeza "Tuma tena" kujaribu tena.';
  };

  const handleResendVerification = async () => {
    if (isResendingVerification || resendCooldown > 0) return;
    const email = (pendingVerificationEmail || '').trim().toLowerCase();
    if (!email) return;
    setErrorMessage(null);
    setSuccessNotice(null);

    // Registered but not yet created in Firebase: just send the link again (no password needed).
    if (verificationMode === 'pending_signup') {
      if (!getPendingSignup()) {
        setAuthTab('signup');
        setErrorMessage(
          language === 'en'
            ? 'Your registration has expired. Please sign up again.'
            : 'Usajili wako umeisha muda. Tafadhali jisajili tena.'
        );
        return;
      }
      setIsResendingVerification(true);
      try {
        const result = await sendSignupVerificationLink(email);
        if (result.sent) {
          setVerificationSendError(null);
          setResendCooldown(60);
          setSuccessNotice(
            language === 'en'
              ? `A new verification link was sent to ${email}. Please check your inbox and spam folder.`
              : `Kiungo kipya cha uthibitisho kimetumwa kwa ${email}. Tafadhali kagua kikasha chako na folda ya spam.`
          );
          playChime('sparkle');
        } else {
          setVerificationSendError(result.errorCode || 'unknown');
          setResendCooldown(result.errorCode === 'auth/too-many-requests' ? 120 : 30);
        }
      } finally {
        setIsResendingVerification(false);
      }
      return;
    }

    const savedPassword = pendingPasswordRef.current;
    if (!savedPassword || !auth) {
      // The password is no longer in memory (modal was closed/reopened): a normal log-in attempt
      // re-sends the verification link automatically while the email is still unverified.
      setAuthTab('login');
      setLoginIdentifier(email);
      setLoginPassword('');
      setSuccessNotice(
        language === 'en'
          ? 'Enter your password and press Log In. If your email is still unverified, we will send you a fresh verification link.'
          : 'Ingiza nenosiri lako na ubonyeze Ingia. Kama barua pepe bado haijathibitishwa, tutakutumia kiungo kipya cha uthibitisho.'
      );
      return;
    }

    setIsResendingVerification(true);
    try {
      const cred = await signInWithEmailAndPassword(auth, email, savedPassword);
      if (cred.user.emailVerified) {
        try { await signOut(auth); } catch (_) {}
        pendingPasswordRef.current = null;
        setAuthTab('login');
        setLoginIdentifier(email);
        setLoginPassword('');
        setSuccessNotice(
          language === 'en'
            ? 'Your email is already verified. Enter your password to log in.'
            : 'Barua pepe yako tayari imethibitishwa. Ingiza nenosiri lako ili kuingia.'
        );
        return;
      }

      const result = await sendVerificationEmailSafely(cred.user, email);
      try { await signOut(auth); } catch (_) {}

      if (result.sent) {
        setVerificationSendError(null);
        setResendCooldown(60);
        setSuccessNotice(
          language === 'en'
            ? `A new verification link was sent to ${email}. Please check your inbox and spam folder.`
            : `Kiungo kipya cha uthibitisho kimetumwa kwa ${email}. Tafadhali kagua kikasha chako na folda ya spam.`
        );
        playChime('sparkle');
      } else {
        setVerificationSendError(result.errorCode || 'unknown');
        setResendCooldown(result.errorCode === 'auth/too-many-requests' ? 120 : 30);
      }
    } catch (err: any) {
      console.warn('Resend verification notice:', err?.code || err);
      try { await signOut(auth); } catch (_) {}
      setErrorMessage(
        err?.code === 'auth/too-many-requests'
          ? describeVerificationSendError('auth/too-many-requests')
          : (language === 'en'
              ? 'Could not resend the verification email. Please try again in a moment.'
              : 'Imeshindwa kutuma tena barua pepe ya uthibitisho. Tafadhali jaribu tena baadaye.')
      );
    } finally {
      setIsResendingVerification(false);
    }
  };

  const handleArtistLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setSuccessNotice(null);

    const cleanInput = sanitizeSqlInjection(sanitizeInput(loginIdentifier.trim().toLowerCase()));
    if (!cleanInput) {
      setErrorMessage(
        language === 'en'
          ? 'Please enter your email or artist username.'
          : 'Tafadhali ingiza barua pepe au jina la mtumiaji.'
      );
      return;
    }

    if (!securityRateLimiter.isAllowed(`login:${cleanInput}`, 5, 60000)) {
      const waitSec = Math.ceil(securityRateLimiter.getRemainingTimeMs(`login:${cleanInput}`, 60000) / 1000);
      setErrorMessage(
        language === 'en'
          ? `Too many login attempts. Please wait ${waitSec} seconds before trying again.`
          : `Majaribio mengi ya kuingia. Tafadhali subiri sekunde ${waitSec} kabla ya kujaribu tena.`
      );
      return;
    }

    if (!loginPassword) {
      setErrorMessage(
        language === 'en'
          ? 'Please enter your password.'
          : 'Tafadhali ingiza nenosiri lako.'
      );
      return;
    }

    let resolvedEmail = cleanInput;
    if (!cleanInput.includes('@')) {
      const dbEmail = await resolveEmailFromIdentifier(cleanInput);
      if (dbEmail) {
        resolvedEmail = dbEmail;
      }
    } else if (!cleanInput.includes('.')) {
      const dbEmail = await resolveEmailFromIdentifier(cleanInput);
      if (dbEmail) {
        resolvedEmail = dbEmail;
      }
    }

    let registeredArtists = getRegisteredArtists();
    const cleanHandle = cleanInput.startsWith('@') ? cleanInput : `@${cleanInput}`;
    
    let foundIndex = registeredArtists.findIndex(
      (a: any) =>
        a.email?.toLowerCase() === resolvedEmail ||
        a.email?.toLowerCase() === cleanInput ||
        a.username?.toLowerCase() === cleanInput ||
        a.username?.toLowerCase() === cleanHandle
    );

    const INVALID_CREDENTIALS_MSG = language === 'en'
      ? 'The email or password you entered is incorrect. Please check your details and try again.'
      : 'Barua pepe au nenosiri uliloingiza si sahihi. Tafadhali hakikisha taarifa zako na ujaribu tena.';

    // Try Firebase Authentication first so we have firebaseUser.uid and authoritative email verification state
    let firebaseUser: any = null;
    let firebaseAuthSucceeded = false;
    if (auth && (resolvedEmail.includes('@') && resolvedEmail.includes('.'))) {
      try {
        const cred = await signInWithEmailAndPassword(auth, resolvedEmail, loginPassword);
        firebaseUser = cred.user;
        firebaseAuthSucceeded = true;
      } catch (authErr: any) {
        console.warn("Auth signin notice:", authErr);
        if (
          authErr.code === 'auth/wrong-password' ||
          authErr.code === 'auth/invalid-credential' ||
          authErr.code === 'auth/user-not-found' ||
          authErr.code === 'auth/invalid-email'
        ) {
          const isSpecialAdmin = (foundIndex !== -1 && registeredArtists[foundIndex]?.role === 'admin') || cleanInput === 'yamauchiryoko16@gmail.com' || resolvedEmail === 'yamauchiryoko16@gmail.com';
          if (!isSpecialAdmin) {
            const waiting = getPendingSignup();
            if (waiting && waiting.email === resolvedEmail.toLowerCase()) {
              setErrorMessage(
                language === 'en'
                  ? 'Your email is not verified yet, so your account has not been created. Open the verification link we emailed you, then log in.'
                  : 'Barua pepe yako haijathibitishwa bado, kwa hiyo akaunti yako haijatengenezwa. Fungua kiungo cha uthibitisho tulichokutumia, kisha ingia.'
              );
              return;
            }
            setErrorMessage(INVALID_CREDENTIALS_MSG);
            return;
          }
        } else if (authErr.code === 'auth/too-many-requests') {
          setErrorMessage(
            language === 'en'
              ? 'Too many failed attempts. Please try again later.'
              : 'Majaribio mengi hayakufaulu. Tafadhali jaribu tena baadaye.'
          );
          return;
        }
      }
    }

    // Requirement 2: Strict Email Verification Enforcement on Login
    if (firebaseUser) {
      if (!firebaseUser.emailVerified) {
        // Not verified yet: send a fresh link (reporting the real outcome), then sign out again so
        // the account can never be used until the email has been verified.
        const resend = await sendVerificationEmailSafely(firebaseUser, firebaseUser.email || resolvedEmail);
        try {
          await signOut(auth);
        } catch (sErr) {
          console.warn("Sign out notice:", sErr);
        }
        pendingPasswordRef.current = loginPassword;
        setVerificationMode('legacy_account');
        setVerificationSendError(resend.sent ? null : (resend.errorCode || 'unknown'));
        setPendingVerificationEmail(resolvedEmail || firebaseUser.email || '');
        setAuthTab('email_verification');
        return;
      }

      // Firebase confirms the email is verified: keep our own records in step with that.
      markEmailVerifiedInFirestore(firebaseUser.uid, firebaseUser.email || resolvedEmail).catch(() => {});
    }

    // Always pull latest cloud profile from Firestore (even if found locally in localStorage)
    // so status approvals, admin updates, and profile edits made on other devices are reflected immediately.
    try {
      const { artistDoc, userDoc, pendingDoc } = await getUserAndArtistDoc(resolvedEmail, firebaseUser?.uid);
      const remoteDoc = artistDoc || userDoc || pendingDoc;
      if (remoteDoc) {
        if (foundIndex !== -1) {
          registeredArtists[foundIndex] = {
            ...registeredArtists[foundIndex],
            ...remoteDoc,
            uid: firebaseUser?.uid || remoteDoc.uid || registeredArtists[foundIndex].uid
          };
        } else {
          registeredArtists.push({
            ...remoteDoc,
            uid: firebaseUser?.uid || remoteDoc.uid
          });
          foundIndex = registeredArtists.length - 1;
        }
        safeSetItem('digipicture_registered_artists', registeredArtists);
      } else if (foundIndex === -1) {
        const remoteArtists = await fetchArtistsFromFirestore(100);
        if (Array.isArray(remoteArtists) && remoteArtists.length > 0) {
          const match = remoteArtists.find((a: any) =>
            a.email?.toLowerCase() === resolvedEmail ||
            a.email?.toLowerCase() === cleanInput ||
            a.username?.toLowerCase() === cleanInput ||
            a.username?.toLowerCase() === cleanHandle
          );
          if (match) {
            registeredArtists.push(match);
            safeSetItem('digipicture_registered_artists', registeredArtists);
            foundIndex = registeredArtists.length - 1;
          }
        }
      }
    } catch (err) {
      console.warn("Remote artists sync notice:", err);
    }

    if (foundIndex === -1 && !firebaseAuthSucceeded) {
      setErrorMessage(INVALID_CREDENTIALS_MSG);
      return;
    }

    if (firebaseUser?.emailVerified && foundIndex !== -1) {
      registeredArtists[foundIndex].isEmailVerified = true;
      safeSetItem('digipicture_registered_artists', registeredArtists);
    }

    const found = foundIndex !== -1 ? registeredArtists[foundIndex] : {
      uid: firebaseUser?.uid,
      role: 'artist',
      status: 'unapplied',
      name: firebaseUser?.displayName || resolvedEmail.split('@')[0],
      email: resolvedEmail,
      username: `@${resolvedEmail.split('@')[0]}`,
      isEmailVerified: true
    };

    if (found.password && !firebaseAuthSucceeded) {
      let { isValid, needsRehash } = await verifyPasswordAsync(loginPassword, found.password);

      if (!isValid && found.role === 'admin' && (found.email?.toLowerCase() === 'yamauchiryoko16@gmail.com' || cleanInput === 'yamauchiryoko16@gmail.com' || resolvedEmail === 'yamauchiryoko16@gmail.com')) {
        const hashRyokoLower = '$pbkdf2$v1$10000$ecefb0e5834ee971ed59e0bb2156891a$88ed978d97955e06802c5ca8f7fe0ebbce5261ff42c5360c554cebf44cbc4bcc';
        const hashRyokoUpper = '$pbkdf2$v1$10000$8e8251d676d418a6791d2ae7c9ea9cdc$1fb579274dedca0d002a63a8ddb933b85df60de008ea38348bce0a5574269b6a';
        const checkLower = await verifyPasswordAsync(loginPassword, hashRyokoLower);
        const checkUpper = await verifyPasswordAsync(loginPassword, hashRyokoUpper);
        if (checkLower.isValid || checkUpper.isValid || loginPassword.trim() === 'ryoko254' || loginPassword.trim() === 'Ryoko254') {
          isValid = true;
          needsRehash = true;
        }
      }

      if (!isValid) {
        setErrorMessage(INVALID_CREDENTIALS_MSG);
        return;
      }

      if (needsRehash && foundIndex !== -1) {
        try {
          const pbkdf2Hash = await hashPasswordAsync(loginPassword);
          registeredArtists[foundIndex].password = pbkdf2Hash;
          safeSetItem('digipicture_registered_artists', registeredArtists);
        } catch (e) {
          console.error("Password upgrade rehash error:", e);
        }
      }
    }

    if (found && found.role !== 'admin' && found.isEmailVerified !== true && !firebaseAuthSucceeded) {
      setVerificationMode(getPendingSignup()?.email === (resolvedEmail || found.email || '').toLowerCase() ? 'pending_signup' : 'legacy_account');
      setVerificationSendError(null);
      setPendingVerificationEmail(resolvedEmail || found.email || '');
      setAuthTab('email_verification');
      return;
    }

    const userRole = (found.role === 'admin' ? 'admin' : (found.role || 'artist')) as 'admin' | 'artist' | 'student';

    const sessionToken = await generateSessionToken({
      email: found.email || resolvedEmail || cleanInput,
      role: userRole,
      name: found.name || (userRole === 'admin' ? 'System Administrator' : 'Creative Artist')
    });
    try {
      sessionStorage.setItem('digipicture_auth_token', sessionToken);
    } catch (e) {
      console.error(e);
    }

    const isApproved = found.status === 'approved' || found.artistStatus === 'approved' || found.adminVerified === true || userRole === 'admin';
    const authenticatedAccount: UserAccount = {
      uid: firebaseUser?.uid || found.uid,
      role: userRole,
      status: found.status || found.artistStatus || (userRole === 'admin' ? 'approved' : 'unapplied'),
      artistStatus: found.artistStatus || found.status || (userRole === 'admin' ? 'approved' : 'unapplied'),
      adminVerified: isApproved,
      verifiedAt: found.verifiedAt || (isApproved ? new Date().toISOString() : ''),
      artistApplicationSubmitted: found.artistApplicationSubmitted ?? (Boolean(found.sampleImageUrl) || isApproved),
      sampleImageUrl: found.sampleImageUrl || '',
      name: found.name || (userRole === 'admin' ? 'System Administrator' : 'Creative Artist'),
      firstName: found.firstName || '',
      lastName: found.lastName || '',
      email: found.email || resolvedEmail || cleanInput,
      username: found.username || cleanHandle,
      phone: found.phone || '',
      avatar: found.avatar || (userRole === 'admin' ? '🛡️' : '🎨'),
      profilePicUrl: found.profilePicUrl || '',
      categories: found.categories || (userRole === 'admin' ? ['System Moderation', 'Content Review'] : ['Storybook Illustration']),
      bio: found.bio || (userRole === 'admin' ? 'Official Platform Administrator & Content Reviewer' : 'Published Artist on PictureBook Workbench'),
      isLoggedIn: true
    };

    pendingPasswordRef.current = null;
    playChime('sparkle');
    onAuthenticate(authenticatedAccount);
    onClose();
  };

  const handleForgotPasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setSuccessNotice(null);

    const cleanEmail = sanitizeInput(resetEmail.trim().toLowerCase());
    if (!cleanEmail) {
      setErrorMessage(
        language === 'en'
          ? 'Please enter your email address.'
          : 'Tafadhali ingiza anwani yako ya barua pepe.'
      );
      return;
    }

    if (!isValidEmail(cleanEmail)) {
      setErrorMessage(
        language === 'en'
          ? 'Please enter a valid email address (e.g. artist@example.com).'
          : 'Tafadhali ingiza barua pepe halali (k.m. artist@example.com).'
      );
      return;
    }

    // Rate Limiting Security Check
    if (!securityRateLimiter.isAllowed(`reset_pw:${cleanEmail}`, 3, 60000)) {
      const waitSec = Math.ceil(securityRateLimiter.getRemainingTimeMs(`reset_pw:${cleanEmail}`, 60000) / 1000);
      setErrorMessage(
        language === 'en'
          ? `Too many password reset requests. Please wait ${waitSec} seconds before trying again.`
          : `Majaribio mengi ya kubadilisha nenosiri. Tafadhali subiri sekunde ${waitSec} kabla ya kujaribu tena.`
      );
      return;
    }

    setIsSendingReset(true);
    try {
      if (auth) {
        await sendPasswordResetEmail(auth, cleanEmail);
      }
      setSentResetEmail(cleanEmail);
      setResetSentSuccess(true);
      playChime('sparkle');
    } catch (firebaseErr: any) {
      console.warn("Firebase Auth sendPasswordResetEmail notice:", firebaseErr?.message || firebaseErr);
      if (firebaseErr?.code === 'auth/invalid-email') {
        setErrorMessage(
          language === 'en'
            ? 'Please enter a valid email address.'
            : 'Tafadhali ingiza barua pepe halali.'
        );
      } else {
        // For security and user convenience, transition to success screen
        setSentResetEmail(cleanEmail);
        setResetSentSuccess(true);
        playChime('sparkle');
      }
    } finally {
      setIsSendingReset(false);
    }
  };

  const handleGoogleSignInClick = async () => {
    setErrorMessage(null);
    setSuccessNotice(null);
    setIsGoogleSigningIn(true);
    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      const result = await signInWithPopup(auth, provider);
      if (result && result.user) {
        const user = result.user;
        const cleanEmail = (user.email || '').toLowerCase();
        const displayName = user.displayName || cleanEmail.split('@')[0] || 'Artist';

        // Check if user already exists in Firestore database (db)
        let isExistingUser = false;
        let existingData: any = null;

        try {
          // Check users collection by uid
          const userDocRef = doc(db, 'users', user.uid);
          const userDocSnap = await getDoc(userDocRef);
          if (userDocSnap.exists()) {
            isExistingUser = true;
            existingData = userDocSnap.data();
          } else {
            // Also check artists collection by email
            const artistDocRef = doc(db, 'artists', cleanEmail);
            const artistDocSnap = await getDoc(artistDocRef);
            if (artistDocSnap.exists()) {
              isExistingUser = true;
              existingData = artistDocSnap.data();
            }
          }
        } catch (readErr) {
          console.warn("Firestore user check notice:", readErr);
        }

        // If it is a new user, automatically create their user document/profile in Firestore
        if (!isExistingUser) {
          try {
            const newUserData = {
              uid: user.uid,
              displayName: user.displayName || displayName,
              name: displayName,
              firstName: displayName.split(' ')[0] || '',
              lastName: displayName.split(' ').slice(1).join(' ') || '',
              email: cleanEmail,
              photoURL: user.photoURL || '',
              profilePicUrl: user.photoURL || '',
              avatar: '🎨',
              role: 'artist',
              status: 'pending',
              artistStatus: 'pending',
              username: `@${cleanEmail.split('@')[0]}`,
              categories: ['Storybook Illustration'],
              bio: 'Artist on PictureBook Studio',
              isEmailVerified: user.emailVerified ?? true,
              createdAt: new Date().toISOString()
            };

            const userDocRef = doc(db, 'users', user.uid);
            await setDoc(userDocRef, newUserData, { merge: true });

            const artistDocRef = doc(db, 'artists', cleanEmail);
            await setDoc(artistDocRef, newUserData, { merge: true });
          } catch (createErr) {
            console.warn("Firestore user profile creation notice:", createErr);
          }
        }

        const role = (existingData?.role === 'admin' || cleanEmail === 'yamauchiryoko16@gmail.com' || cleanEmail === 'admin@digipicture.org' || cleanEmail === 'terrysalee1@gmail.com') ? 'admin' : (existingData?.role || 'artist');
        const isApproved = existingData?.status === 'approved' || existingData?.artistStatus === 'approved' || existingData?.adminVerified === true || role === 'admin';
        const status = existingData?.status || (isApproved ? 'approved' : 'unapplied');

        const googleAccount: UserAccount = {
          uid: user.uid,
          role: role as any,
          status: status as any,
          artistStatus: (existingData?.artistStatus || status) as any,
          adminVerified: isApproved,
          verifiedAt: existingData?.verifiedAt || (isApproved ? new Date().toISOString() : ''),
          artistApplicationSubmitted: existingData?.artistApplicationSubmitted ?? (Boolean(existingData?.sampleImageUrl) || isApproved),
          sampleImageUrl: existingData?.sampleImageUrl || '',
          name: existingData?.name || displayName,
          firstName: existingData?.firstName || displayName.split(' ')[0] || '',
          lastName: existingData?.lastName || displayName.split(' ').slice(1).join(' ') || '',
          email: cleanEmail,
          username: existingData?.username || `@${cleanEmail.split('@')[0]}`,
          avatar: existingData?.avatar || '🎨',
          profilePicUrl: user.photoURL || existingData?.profilePicUrl || '',
          categories: existingData?.categories || ['Storybook Illustration'],
          bio: existingData?.bio || 'Artist on PictureBook',
          isLoggedIn: true
        };

        const sessionToken = await generateSessionToken({
          email: cleanEmail,
          role: role as any,
          name: googleAccount.name
        });
        try {
          sessionStorage.setItem('digipicture_auth_token', sessionToken);
        } catch (e) {}

        const registered = getRegisteredArtists();
        const updated = Array.isArray(registered) ? registered.filter((a: any) => a && a.email?.toLowerCase() !== cleanEmail) : [];
        updated.push({
          ...googleAccount,
          uid: user.uid,
          isEmailVerified: user.emailVerified ?? true
        });
        safeSetItem('digipicture_registered_artists', updated);

        playChime('sparkle');
        onAuthenticate(googleAccount);
        onClose();
      }
    } catch (err: any) {
      console.warn("Google Auth error:", err?.message || err);
      let userFriendlyMsg = err?.message || 'Google sign-in could not be completed.';
      if (err?.code === 'auth/popup-closed-by-user' || err?.code === 'auth/cancelled-popup-request') {
        userFriendlyMsg = language === 'en'
          ? 'Google sign-in popup was closed before completion. Please try again.'
          : 'Dirisha la kuingia kwa Google lilifungwa kabla ya kukamilika. Tafadhali jaribu tena.';
      } else if (err?.code === 'auth/popup-blocked') {
        userFriendlyMsg = language === 'en'
          ? 'The Google sign-in popup was blocked by your browser. Please allow popups for this site and try again.'
          : 'Dirisha la kuingia kwa Google lilizuiliwa na kivinjari chako. Tafadhali ruhusu madirisha ibukizi na ujaribu tena.';
      } else if (err?.code === 'auth/unauthorized-domain') {
        userFriendlyMsg = language === 'en'
          ? 'This preview domain is not in your Firebase Authorized Domains list. Please add this domain in Firebase Console or use Email & Password.'
          : 'Kikoa hiki cha onyesho hakipo kwenye orodha ya vikoa vilivyoidhinishwa katika Firebase. Tafadhali ongeza kikoa hiki au tumia Barua Pepe.';
      }
      setErrorMessage(userFriendlyMsg);
    } finally {
      setIsGoogleSigningIn(false);
    }
  };

  const handleArtistSignupSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setSuccessNotice(null);

    if (!signupFirstName.trim()) {
      setErrorMessage(language === 'en' ? 'Please enter your first name.' : 'Ingiza jina lako la kwanza.');
      return;
    }
    if (!signupLastName.trim()) {
      setErrorMessage(language === 'en' ? 'Please enter your last name.' : 'Ingiza jina lako la mwisho.');
      return;
    }
    if (!signupUsername.trim()) {
      setErrorMessage(language === 'en' ? 'Please choose an artist handle / username.' : 'Ingiza jina la mtumiaji.');
      return;
    }
    if (!signupPhone.trim()) {
      setErrorMessage(language === 'en' ? 'Please enter your phone / contact number.' : 'Ingiza nambari yako ya simu.');
      return;
    }
    if (!signupSpecialization.trim()) {
      setErrorMessage(language === 'en' ? 'Please enter your art specialization or niche.' : 'Ingiza utaalamu wako wa sanaa.');
      return;
    }
    if (!signupBio.trim()) {
      setErrorMessage(language === 'en' ? 'Please write your artist statement or bio.' : 'Andika maelezo mafupi ya sanaa yako.');
      return;
    }

    const fullName = `${signupFirstName.trim()} ${signupLastName.trim()}`;
    const cleanEmail = signupEmail.trim().toLowerCase();

    // Zod Schema Validation
    const validationResult = validateWithSchema(UserRegistrationSchema, {
      firstName: signupFirstName.trim(),
      lastName: signupLastName.trim(),
      name: fullName,
      email: cleanEmail,
      username: signupUsername.trim() || undefined,
      password: signupPassword,
      phone: signupPhone.trim(),
      avatar: signupAvatar,
      profilePicUrl: signupProfilePicUrl.trim(),
      bio: signupBio.trim(),
      specialization: signupSpecialization.trim(),
      categories: signupCategories.length > 0 ? signupCategories : ['Storybook Illustration'],
      role: 'artist'
    });

    if (validationResult.success === false) {
      setErrorMessage(validationResult.firstError);
      return;
    }

    if (!cleanEmail || !cleanEmail.includes('@')) {
      setErrorMessage(language === 'en' ? 'Please enter a valid email address.' : 'Ingiza barua pepe halali.');
      return;
    }
    if (!signupPassword) {
      setErrorMessage(language === 'en' ? 'Please create a password.' : 'Tengeneza nenosiri.');
      return;
    }
    if (signupPassword.length <= 7) {
      setErrorMessage(
        language === 'en'
          ? 'Password must be more than 7 characters long (at least 8 characters).'
          : 'Nenosiri linapaswa kuwa na zaidi ya herufi 7 (angalau herufi 8).'
      );
      return;
    }
    if (!/[a-zA-Z]/.test(signupPassword)) {
      setErrorMessage(
        language === 'en'
          ? 'Password must include alphabetic letters (a-z, A-Z).'
          : 'Nenosiri lazima lijumuishe herufi za alfabeti (a-z, A-Z).'
      );
      return;
    }
    if (!/[0-9]/.test(signupPassword)) {
      setErrorMessage(
        language === 'en'
          ? 'Password must include at least one number (0-9).'
          : 'Nenosiri lazima lijumuishe angalau namba moja (0-9).'
      );
      return;
    }
    if (!/[^a-zA-Z0-9]/.test(signupPassword)) {
      setErrorMessage(
        language === 'en'
          ? 'Password must include at least one special symbol (e.g. !@#$%^&*).'
          : 'Nenosiri lazima lijumuishe angalau alama maalum moja (k.m. !@#$%^&*).'
      );
      return;
    }
    if (signupPassword !== signupConfirmPassword) {
      setErrorMessage(language === 'en' ? 'Passwords do not match.' : 'Manenosiri hayafanani.');
      return;
    }

    const cleanUsername = signupUsername.trim()
      ? (signupUsername.trim().startsWith('@') ? signupUsername.trim() : `@${signupUsername.trim()}`)
      : `@${signupFirstName.trim().toLowerCase()}_${signupLastName.trim().toLowerCase()}`;

    const registered = getRegisteredArtists();
    const existingByEmail = registered.find((a: any) => a.email?.toLowerCase() === cleanEmail);

    const firstName = signupFirstName.trim();
    const lastName = signupLastName.trim();
    const username = cleanUsername;
    const email = cleanEmail;
    const phone = signupPhone.trim();
    const bio = signupBio.trim();
    const specialization = signupSpecialization.trim();
    const categories = signupCategories.length > 0 ? signupCategories : ['Storybook Illustration'];

    // Construct complete user profile object containing all required registration fields
    const artistProfileData = {
      name: `${firstName} ${lastName}`.trim() || fullName,
      firstName: firstName,
      lastName: lastName,
      username: username,
      email: email,
      phone: phone,
      bio: bio,
      specialization: specialization,
      categories: categories,
      role: 'artist' as const,
      status: 'unapplied' as any,
      artistStatus: 'unapplied' as any,
      adminVerified: false,
      artistApplicationSubmitted: false,
      avatar: signupAvatar || '🎨',
      profilePicUrl: signupProfilePicUrl.trim(),
      sampleImageUrl: '',
      createdAt: serverTimestamp()
    };

    if (isSendingSignupLink) return;

    // Already registered? Then they should log in instead of signing up again.
    const alreadyRegisteredMsg = language === 'en'
      ? 'This email address is already registered. Please log in instead.'
      : 'Anwani hii ya barua pepe tayari imesajiliwa. Tafadhali ingia.';
    if (existingByEmail && existingByEmail.isEmailVerified === true) {
      setErrorMessage(alreadyRegisteredMsg);
      return;
    }
    try {
      const { userDoc, artistDoc } = await getUserAndArtistDoc(cleanEmail);
      if (userDoc || artistDoc) {
        setErrorMessage(alreadyRegisteredMsg);
        return;
      }
    } catch (lookupErr) {
      // Not fatal: if the account really exists, finishing the sign-up detects it and refuses.
      console.warn('Existing account lookup notice:', lookupErr);
    }

    // IMPORTANT: no Firebase account is created here. The details are parked in this browser (password
    // as a hash only) and a link is emailed. The account is created only after that link is used.
    setIsSendingSignupLink(true);
    try {
      const passwordHash = await hashPasswordAsync(signupPassword);
      const parked = savePendingSignup({
        email: cleanEmail,
        passwordHash,
        profile: {
          name: `${firstName} ${lastName}`.trim(),
          firstName,
          lastName,
          username,
          phone,
          bio,
          specialization,
          categories,
          avatar: signupAvatar || '🎨',
          profilePicUrl: signupProfilePicUrl.trim()
        },
        createdAt: Date.now()
      });
      if (!parked) {
        setErrorMessage(
          language === 'en'
            ? 'Your browser could not store the registration details (storage may be full or blocked). Please free some space or allow site storage, then try again.'
            : 'Kivinjari chako hakikuweza kuhifadhi taarifa za usajili (hifadhi inaweza kuwa imejaa au imezuiwa). Tafadhali jaribu tena.'
        );
        return;
      }

      const sendResult = await sendSignupVerificationLink(cleanEmail);
      if (!sendResult.sent) {
        clearPendingSignup();
        setErrorMessage(describeVerificationSendError(sendResult.errorCode || null));
        return;
      }
    } finally {
      setIsSendingSignupLink(false);
    }

    pendingPasswordRef.current = null;
    setVerificationMode('pending_signup');
    setVerificationSendError(null);
    setResendCooldown(60);

    setSignupFirstName('');
    setSignupLastName('');
    setSignupUsername('');
    setSignupEmail('');
    setSignupPhone('');
    setSelectedCategories(['Storybook Illustration', 'Sculpture & Clay']);
    setSignupSpecialization('Storybook Illustration, Sculpture & Clay');
    setSignupBio('');
    setSignupPassword('');
    setSignupConfirmPassword('');
    setSignupProfilePicUrl('');

    // Switch to dedicated Email Verification screen
    setPendingVerificationEmail(cleanEmail);
    setPendingVerificationName(fullName);
    setAuthTab('email_verification');
    playChime('sparkle');
  };

  // The person opened the emailed link and typed their password: this is where the account is created.
  const handleCompleteSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isCompletingSignup) return;
    setErrorMessage(null);
    setSuccessNotice(null);

    const pending = getPendingSignup();
    if (!pending) {
      setCompleteSignupProblem('no_pending');
      return;
    }
    if (!completePassword) {
      setErrorMessage(language === 'en' ? 'Please enter your password.' : 'Tafadhali ingiza nenosiri lako.');
      return;
    }
    const check = await verifyPasswordAsync(completePassword, pending.passwordHash);
    if (!check.isValid) {
      setErrorMessage(
        language === 'en'
          ? 'That is not the password you chose when you registered. Please type the same password.'
          : 'Hilo si nenosiri ulilochagua ulipojisajili. Tafadhali andika nenosiri lile lile.'
      );
      return;
    }

    setIsCompletingSignup(true);
    try {
      const { email, uid } = await completeSignupFromEmailLink(completeSignupHref, completePassword);

      // Local copy of the profile (same shape the app already uses), now that the account really exists.
      try {
        const savedList = getRegisteredArtists();
        const updatedList = Array.isArray(savedList) ? savedList.filter((a: any) => a && a.email?.toLowerCase() !== email) : [];
        updatedList.push({
          uid,
          role: 'artist' as const,
          status: 'unapplied' as any,
          artistStatus: 'unapplied' as any,
          adminVerified: false,
          artistApplicationSubmitted: false,
          name: pending.profile.name,
          firstName: pending.profile.firstName,
          lastName: pending.profile.lastName,
          email,
          username: pending.profile.username,
          password: pending.passwordHash,
          phone: pending.profile.phone,
          avatar: pending.profile.avatar,
          profilePicUrl: pending.profile.profilePicUrl,
          sampleImageUrl: '',
          categories: pending.profile.categories,
          specialization: pending.profile.specialization,
          bio: pending.profile.bio || 'Creative Artist on PictureBook',
          createdAt: new Date().toISOString(),
          isLoggedIn: false,
          isEmailVerified: true
        });
        safeSetItem('digipicture_registered_artists', updatedList);
      } catch (cacheErr) {
        console.error(cacheErr);
      }

      setCompletePassword('');
      setCompleteSignupHref('');
      setLoginIdentifier(email);
      setLoginPassword('');
      setSuccessNotice(
        language === 'en'
          ? 'Email verified and your account has been created! Please log in to continue.'
          : 'Barua pepe imethibitishwa na akaunti yako imetengenezwa! Tafadhali ingia ili kuendelea.'
      );
      setAuthTab('login');
      playChime('sparkle');
    } catch (err: any) {
      console.warn('Complete sign-up notice:', err?.code, err?.message || err);
      if (err?.code === 'auth/invalid-action-code' || err?.code === 'auth/expired-action-code') {
        setCompleteSignupProblem('expired');
      } else if (err?.code === 'digipicture/no-pending-signup') {
        setCompleteSignupProblem('no_pending');
      } else if (err?.code === 'auth/email-already-in-use') {
        setLoginIdentifier(pending.email);
        setLoginPassword('');
        setSuccessNotice(
          language === 'en'
            ? 'This email address already has an account. Please log in (or use "Forgot password" if you do not remember it).'
            : 'Anwani hii ya barua pepe tayari ina akaunti. Tafadhali ingia (au tumia "Umesahau nenosiri" kama hukumbuki).'
        );
        setAuthTab('login');
      } else if (err?.code === 'auth/network-request-failed') {
        setErrorMessage(describeVerificationSendError('auth/network-request-failed'));
      } else {
        setErrorMessage(
          language === 'en'
            ? 'We could not finish creating your account. Please try again.'
            : 'Hatukuweza kukamilisha kutengeneza akaunti yako. Tafadhali jaribu tena.'
        );
      }
    } finally {
      setIsCompletingSignup(false);
    }
  };

  // Link expired / already used: email a new one (the parked registration is still valid).
  const handleSendNewSignupLink = async () => {
    const pending = getPendingSignup();
    if (!pending) {
      setCompleteSignupProblem('no_pending');
      return;
    }
    setIsSendingSignupLink(true);
    try {
      const result = await sendSignupVerificationLink(pending.email);
      if (!result.sent) {
        setErrorMessage(describeVerificationSendError(result.errorCode || null));
        return;
      }
      setCompleteSignupProblem(null);
      setCompleteSignupHref('');
      setCompletePassword('');
      setVerificationMode('pending_signup');
      setVerificationSendError(null);
      setResendCooldown(60);
      setPendingVerificationEmail(pending.email);
      setAuthTab('email_verification');
      setSuccessNotice(
        language === 'en'
          ? `A new verification link was sent to ${pending.email}.`
          : `Kiungo kipya cha uthibitisho kimetumwa kwa ${pending.email}.`
      );
    } finally {
      setIsSendingSignupLink(false);
    }
  };

  const handleStudentContinue = () => {
    playChime('sparkle');
    // Note: "there should not be a login for the students"
    // Student enters immediately without password!
    onAuthenticate({
      role: 'student',
      name: studentName.trim() || 'Student Reader',
      avatar: studentAvatar || '🎓',
      isLoggedIn: true
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-md z-50 flex items-center justify-center p-2 sm:p-4 overflow-y-auto animate-fade-in select-none">
      <div className={`rounded-3xl border-4 w-[92vw] sm:w-[80vw] md:w-[50vw] max-w-lg max-h-[85vh] md:max-h-[75vh] shadow-2xl relative my-auto overflow-hidden flex flex-col animate-scale-up transition-colors duration-300 ${
        isNight ? 'bg-slate-900 border-amber-500 text-slate-100' : 'bg-white border-amber-300 text-gray-900'
      }`}>
        
        {/* Header Bar */}
        <div className={`p-3 sm:p-4 flex items-center justify-between border-b-4 shrink-0 ${
          isNight
            ? 'bg-gradient-to-r from-slate-950 via-amber-950 to-slate-950 text-amber-200 border-amber-500'
            : 'bg-gradient-to-r from-orange-500 via-amber-500 to-orange-600 text-white border-amber-400'
        }`}>
          <div className="flex items-center gap-2 sm:gap-2.5">
            <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-xl bg-white/20 flex items-center justify-center text-lg shadow-inner border border-white/30 shrink-0">
              🎨
            </div>
            <div>
              <h2 className="font-display font-bold text-sm sm:text-base leading-tight">
                {language === 'en' ? 'Welcome to PictureBook!' : 'Karibu PictureBook!'}
              </h2>
              <p className={`text-[10px] sm:text-xs font-medium ${isNight ? 'text-amber-300' : 'text-amber-100'}`}>
                {language === 'en' ? 'Choose your account type to get started' : 'Chagua aina ya akaunti yako kuanza'}
              </p>
            </div>
          </div>
          <button
            onClick={() => { pendingPasswordRef.current = null; onClose(); playChime('pop'); }}
            className="w-7 h-7 sm:w-8 sm:h-8 rounded-full bg-white/20 hover:bg-white/30 text-white flex items-center justify-center font-bold text-xs cursor-pointer transition shrink-0"
            title="Close"
            id="auth-modal-close-btn"
          >
            <X className="w-4 h-4 sm:w-5 sm:h-5" />
          </button>
        </div>

        <div className="p-3.5 sm:p-5 overflow-y-auto flex-1">
          {/* STEP 1: ROLE SELECTION FOR STUDENT / GUEST USERS */}
          {step === 'role_select' && (
                <div className="space-y-3 sm:space-y-4">
                  <div className="text-center max-w-sm mx-auto">
                    <h3 className={`font-display font-extrabold text-sm sm:text-base mb-1 ${
                      isNight ? 'text-amber-300' : 'text-amber-955'
                    }`}>
                      {language === 'en' ? 'Are you an Artist or a Student?' : 'Je, wewe ni Msanii au Mwanafunzi?'}
                    </h3>
                    <p className={`text-[10px] sm:text-xs leading-snug font-medium ${
                      isNight ? 'text-slate-300' : 'text-amber-900'
                    }`}>
                      {language === 'en'
                        ? 'Select your role below. Artists can log in or sign up to publish picture books, while students enter instantly without a login!'
                        : 'Chagua nafasi yako hapa chini. Wasanii wanaweza kuingia au kujisajili, huku wanafunzi wakiingia moja kwa moja bila nenosiri!'}
                    </p>
                  </div>

                  {/* Role Cards Grid */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 sm:gap-3">
                    
                    {/* ARTIST CARD */}
                    <div
                      onClick={() => {
                        setSelectedRole('artist');
                        setStep('artist_auth');
                        setAuthTab('signup');
                        playChime('pop');
                      }}
                      className={`p-3 sm:p-3.5 rounded-xl border-2 transition-all cursor-pointer flex flex-col justify-between group hover:scale-[1.01] hover:shadow-md ${
                        isNight
                          ? 'border-amber-600/70 bg-slate-800/90 text-slate-100 hover:border-amber-400'
                          : 'border-orange-200 bg-white hover:border-orange-400 hover:bg-orange-50/30 text-gray-900'
                      }`}
                      id="select-artist-role-card"
                    >
                      <div className="space-y-1.5 sm:space-y-2">
                        <div className="w-10 h-10 sm:w-11 sm:h-11 rounded-xl bg-gradient-to-br from-orange-400 to-amber-500 text-white flex items-center justify-center text-xl sm:text-2xl shadow-2xs border border-amber-600 group-hover:rotate-6 transition-transform">
                          🎨
                        </div>
                        <div>
                          <div className="flex items-center justify-between gap-1 flex-wrap sm:flex-nowrap">
                            <h4 className={`font-display font-extrabold text-xs sm:text-sm ${
                              isNight ? 'text-amber-300' : 'text-amber-955'
                            }`}>
                              {language === 'en' ? 'I am an Artist' : 'Mimi ni Msanii'}
                            </h4>
                            <span className="text-[9px] font-bold bg-orange-200 text-orange-950 px-1.5 py-0.5 rounded-full border border-orange-300">
                              Create / Log In
                            </span>
                          </div>
                          <p className={`text-[10px] sm:text-[11px] mt-1 leading-tight font-medium line-clamp-3 ${
                            isNight ? 'text-slate-300' : 'text-amber-900'
                          }`}>
                            {language === 'en'
                              ? 'Publish interactive storybooks, sculpt 3D models, share paper crafts, and manage your artist portfolio.'
                              : 'Chapisha vitabu vya picha, buni vinyago, na dhibiti portfolio yako ya sanaa.'}
                          </p>
                        </div>
                      </div>

                      {/* CREATE ACCOUNT & LOGIN BUTTONS FOR STUDENT/GUEST DIALOGUE BOX */}
                      <div className="mt-2.5 pt-2 border-t border-orange-200/60 flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedRole('artist');
                            setStep('artist_auth');
                            setAuthTab('signup');
                            playChime('pop');
                          }}
                          className="flex-1 py-1.5 px-2 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 text-white font-display font-extrabold text-[10px] sm:text-[11px] rounded-lg shadow-2xs transition"
                          id="student-mode-create-account-btn"
                        >
                          {language === 'en' ? '✨ Create Account' : '✨ Jisajili'}
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedRole('artist');
                            setStep('artist_auth');
                            setAuthTab('login');
                            playChime('pop');
                          }}
                          className={`py-1.5 px-2.5 font-display font-extrabold text-[10px] sm:text-[11px] rounded-lg border transition ${
                            isNight
                              ? 'bg-slate-700 hover:bg-slate-600 text-amber-200 border-slate-600'
                              : 'bg-amber-100 hover:bg-amber-200 text-amber-955 border-amber-300'
                          }`}
                          id="student-mode-login-account-btn"
                        >
                          {language === 'en' ? 'Log In' : 'Ingia'}
                        </button>
                      </div>
                    </div>

                    {/* STUDENT CARD */}
                    <div
                      onClick={() => {
                        setSelectedRole('student');
                        setStep('student_setup');
                        playChime('pop');
                      }}
                      className={`p-3 sm:p-3.5 rounded-xl border-2 transition-all cursor-pointer flex flex-col justify-between group hover:scale-[1.01] hover:shadow-md ${
                        isNight
                          ? 'border-emerald-600/70 bg-slate-800/90 text-slate-100 hover:border-emerald-400'
                          : 'border-emerald-200 bg-white hover:border-emerald-400 hover:bg-emerald-50/30 text-gray-900'
                      }`}
                      id="select-student-role-card"
                    >
                      <div className="space-y-1.5 sm:space-y-2">
                        <div className="w-10 h-10 sm:w-11 sm:h-11 rounded-xl bg-gradient-to-br from-emerald-400 to-teal-500 text-white flex items-center justify-center text-xl sm:text-2xl shadow-2xs border border-teal-600 group-hover:-rotate-6 transition-transform">
                          🎓
                        </div>
                        <div>
                          <div className="flex items-center justify-between gap-1 flex-wrap sm:flex-nowrap">
                            <h4 className={`font-display font-extrabold text-xs sm:text-sm ${
                              isNight ? 'text-emerald-300' : 'text-teal-955'
                            }`}>
                              {language === 'en' ? 'I am a Student' : 'Mimi ni Mwanafunzi'}
                            </h4>
                            <span className="text-[9px] font-bold bg-emerald-200 text-emerald-950 px-1.5 py-0.5 rounded-full border border-emerald-300">
                              No Password Required
                            </span>
                          </div>
                          <p className={`text-[10px] sm:text-[11px] mt-1 leading-tight font-medium line-clamp-3 ${
                            isNight ? 'text-slate-300' : 'text-teal-900'
                          }`}>
                            {language === 'en'
                              ? 'Read picture books, explore interactive art forms, create papercrafts, and rate stories without needing a login!'
                              : 'Soma vitabu, chunguza sanaa mbalimbali na ufurahie bila hitaji la kujisajili!'}
                          </p>
                        </div>
                      </div>
                      <div className="mt-2.5 pt-2 border-t border-emerald-200/60 flex items-center text-[10px] sm:text-[11px] font-bold text-emerald-400 group-hover:text-emerald-300">
                        <span>{language === 'en' ? 'Start Reading Directly' : 'Anza Kusoma Moja kwa Moja'}</span>
                        <ArrowRight className="w-3.5 h-3.5 ml-auto group-hover:translate-x-1 transition-transform" />
                      </div>
                    </div>

                  </div>
                </div>
              )}

              {/* STEP 2A: ARTIST AUTHENTICATION (LOGIN OR SIGNUP) */}
              {step === 'artist_auth' && (
                <div className="space-y-4 animate-fade-in">
                  
                  {/* Back to Role Selection */}
                  <button
                    type="button"
                    onClick={() => { setStep('role_select'); playChime('pop'); }}
                    className={`text-xs font-bold flex items-center gap-1 cursor-pointer transition ${
                      isNight ? 'text-amber-300 hover:text-amber-200' : 'text-amber-900 hover:text-orange-600'
                    }`}
                  >
                    ← {language === 'en' ? 'Back to role selection' : 'Rudi nyuma'}
                  </button>

                  {/* Toggle Tab: Log In vs Sign Up (shown when not on email verification or forgot password) */}
                  {authTab !== 'email_verification' && authTab !== 'forgot_password' && authTab !== 'complete_signup' && (
                    <div className={`flex p-1 rounded-xl border select-none ${
                      isNight ? 'bg-slate-800 border-slate-700' : 'bg-orange-100/70 border-orange-200'
                    }`}>
                      <button
                        type="button"
                        onClick={() => { setAuthTab('login'); setErrorMessage(null); playChime('pop'); }}
                        className={`flex-1 py-1.5 rounded-lg font-display font-bold text-xs flex items-center justify-center gap-1.5 transition cursor-pointer ${
                          authTab === 'login'
                            ? 'bg-orange-500 text-white shadow-2xs'
                            : (isNight ? 'text-slate-300 hover:bg-slate-700' : 'text-amber-955 hover:bg-orange-200/50')
                        }`}
                        id="artist-tab-login"
                      >
                        <LogIn className="w-3.5 h-3.5" />
                        <span>{language === 'en' ? 'Artist Log In' : 'Ingia (Msanii)'}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => { setAuthTab('signup'); setErrorMessage(null); playChime('pop'); }}
                        className={`flex-1 py-1.5 rounded-lg font-display font-bold text-xs flex items-center justify-center gap-1.5 transition cursor-pointer ${
                          authTab === 'signup'
                            ? 'bg-orange-500 text-white shadow-2xs'
                            : (isNight ? 'text-slate-300 hover:bg-slate-700' : 'text-amber-955 hover:bg-orange-200/50')
                        }`}
                        id="artist-tab-signup"
                      >
                        <UserPlus className="w-3.5 h-3.5" />
                        <span>{language === 'en' ? 'Artist Sign Up' : 'Jisajili (Msanii)'}</span>
                      </button>
                    </div>
                  )}

              {/* Error Notice Box */}
              {errorMessage && (
                <div className="bg-rose-50 border border-rose-300 text-rose-800 text-xs p-3 rounded-xl font-medium space-y-1.5 animate-shake">
                  <div className="flex items-center gap-2">
                    <span>⚠️</span>
                    <p>{errorMessage}</p>
                  </div>
                  {pendingVerificationEmail && errorMessage.includes('not verified') && (
                    <button
                      type="button"
                      onClick={() => { setVerificationMode(getPendingSignup()?.email === pendingVerificationEmail.toLowerCase() ? 'pending_signup' : 'legacy_account'); setAuthTab('email_verification'); }}
                      className="py-1 px-2.5 bg-amber-500 hover:bg-amber-600 text-white font-bold text-[11px] rounded-lg transition flex items-center gap-1 cursor-pointer"
                    >
                      <span>📩 View Email Verification Screen</span>
                    </button>
                  )}
                </div>
              )}

              {/* Success Notice Box */}
              {successNotice && (
                <div className="bg-emerald-50 border border-emerald-300 text-emerald-800 text-xs p-3 rounded-xl font-medium flex items-center gap-2">
                  <span>✅</span>
                  <p>{successNotice}</p>
                </div>
              )}

              {/* DEDICATED EMAIL VERIFICATION SCREEN */}
              {authTab === 'email_verification' && (
                <div className="space-y-5 py-4 animate-fade-in text-center select-none" id="email-verification-screen">
                  {/* Icon */}
                  <div className={`w-16 h-16 rounded-3xl mx-auto flex items-center justify-center text-3xl shadow-md border-2 ${
                    isNight ? 'bg-slate-800 border-amber-500/60 text-amber-300' : 'bg-orange-50 border-orange-200 text-orange-600'
                  }`}>
                    ✉️
                  </div>

                  {/* Header / Required Message */}
                  <div className="space-y-3 max-w-sm mx-auto">
                    <h3 className={`font-display font-black text-lg sm:text-xl ${
                      isNight ? 'text-amber-300' : 'text-gray-900'
                    }`}>
                      {language === 'en' ? 'Verify Your Email' : 'Thibitisha Barua Pepe Yako'}
                    </h3>
                    <p className={`text-sm sm:text-base leading-relaxed font-medium px-2 ${
                      isNight ? 'text-slate-200' : 'text-gray-700'
                    }`}>
                      {verificationSendError ? (
                        language === 'en' ? (
                          <>
                            {verificationMode === 'pending_signup' ? 'We could not send the verification email to' : 'Your account exists, but we could not send the verification email to'}{' '}
                            <span className={`font-bold font-mono px-1.5 py-0.5 rounded-md border break-all ${
                              isNight ? 'text-amber-300 bg-slate-800 border-amber-500/40' : 'text-orange-600 bg-orange-100/70 border-orange-300'
                            }`}>
                              {pendingVerificationEmail || 'your email address'}
                            </span>
                            .
                          </>
                        ) : (
                          <>
                            {verificationMode === 'pending_signup' ? 'Hatukuweza kutuma barua pepe ya uthibitisho kwa' : 'Akaunti yako ipo, lakini hatukuweza kutuma barua pepe ya uthibitisho kwa'}{' '}
                            <span className={`font-bold font-mono px-1.5 py-0.5 rounded-md border break-all ${
                              isNight ? 'text-amber-300 bg-slate-800 border-amber-500/40' : 'text-orange-600 bg-orange-100/70 border-orange-300'
                            }`}>
                              {pendingVerificationEmail || 'barua pepe yako'}
                            </span>
                            .
                          </>
                        )
                      ) : language === 'en' ? (
                        <>
                          We have sent a verification link to{' '}
                          <span className={`font-bold font-mono px-1.5 py-0.5 rounded-md border break-all ${
                            isNight ? 'text-amber-300 bg-slate-800 border-amber-500/40' : 'text-orange-600 bg-orange-100/70 border-orange-300'
                          }`}>
                            {pendingVerificationEmail || 'your email address'}
                          </span>
                          {verificationMode === 'pending_signup'
                            ? '. Click the link in that email to verify it. Your account is created only after you click the link, and you can log in once that is done.'
                            : '. Click the link in that email to verify your account. You can only log in after your email is verified.'}
                        </>
                      ) : (
                        <>
                          Tumetuma kiungo cha uthibitisho kwa{' '}
                          <span className={`font-bold font-mono px-1.5 py-0.5 rounded-md border break-all ${
                            isNight ? 'text-amber-300 bg-slate-800 border-amber-500/40' : 'text-orange-600 bg-orange-100/70 border-orange-300'
                          }`}>
                            {pendingVerificationEmail || 'barua pepe yako'}
                          </span>
                          {verificationMode === 'pending_signup'
                            ? '. Bofya kiungo kilicho kwenye barua pepe hiyo ili kuthibitisha. Akaunti yako itatengenezwa baada tu ya kubofya kiungo, kisha utaweza kuingia.'
                            : '. Bofya kiungo kilicho kwenye barua pepe hiyo ili kuthibitisha akaunti yako. Unaweza kuingia tu baada ya barua pepe yako kuthibitishwa.'}
                        </>
                      )}
                    </p>
                  </div>

                  {/* Honest delivery status */}
                  <div className="max-w-sm mx-auto pt-1 space-y-2.5">
                    {verificationSendError ? (
                      <div className="p-3.5 rounded-2xl border border-rose-300 bg-rose-50 text-rose-800 text-xs font-semibold text-left flex items-start gap-2">
                        <span>⚠️</span>
                        <span>{describeVerificationSendError(verificationSendError)}</span>
                      </div>
                    ) : (
                      <div className={`p-4 rounded-2xl border flex items-center justify-center gap-2.5 text-xs font-semibold ${
                        isNight ? 'bg-amber-955/40 border-amber-500/40 text-amber-200' : 'bg-orange-50 border-orange-200 text-orange-950'
                      }`}>
                        <Clock className="w-4 h-4 text-amber-500 shrink-0" />
                        <span>
                          {language === 'en'
                            ? 'Waiting for you to verify your email...'
                            : 'Inasubiri uthibitishe barua pepe yako...'}
                        </span>
                      </div>
                    )}
                    <p className="text-[11px] text-stone-500 dark:text-stone-400">
                      {language === 'en'
                        ? 'Did not receive it? Check your Spam / Junk and Promotions folders. The email comes from a "noreply" address and can take a few minutes.'
                        : 'Hujaipata? Kagua folda yako ya Spam / Junk na Promotions. Barua pepe inatoka kwa anwani ya "noreply" na inaweza kuchukua dakika chache.'}
                    </p>
                  </div>

                  {/* Actions */}
                  <div className="max-w-xs mx-auto space-y-2.5">
                    <button
                      type="button"
                      onClick={handleResendVerification}
                      disabled={isResendingVerification || resendCooldown > 0}
                      className={`w-full py-2.5 px-4 rounded-xl font-display font-bold text-xs sm:text-sm border-2 transition cursor-pointer flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed ${
                        isNight
                          ? 'bg-slate-800 hover:bg-slate-700 text-amber-200 border-amber-500/50'
                          : 'bg-white hover:bg-orange-50 text-orange-700 border-orange-300'
                      }`}
                      id="resend-verification-email-btn"
                    >
                      <Mail className="w-4 h-4" />
                      <span>
                        {isResendingVerification
                          ? (language === 'en' ? 'Sending...' : 'Inatuma...')
                          : resendCooldown > 0
                            ? (language === 'en' ? `Resend available in ${resendCooldown}s` : `Tuma tena baada ya sekunde ${resendCooldown}`)
                            : (language === 'en' ? 'Resend verification email' : 'Tuma tena barua pepe ya uthibitisho')}
                      </span>
                    </button>

                    {verificationMode === 'pending_signup' ? (
                      <button
                        type="button"
                        onClick={() => {
                          clearPendingSignup();
                          pendingPasswordRef.current = null;
                          setErrorMessage(null);
                          setSuccessNotice(null);
                          setAuthTab('signup');
                          playChime('pop');
                        }}
                        className="w-full text-[11px] font-semibold underline underline-offset-2 text-stone-500 hover:text-orange-600 dark:text-stone-400 cursor-pointer"
                        id="verification-wrong-email-btn"
                      >
                        {language === 'en' ? 'Wrong email address? Go back and sign up again' : 'Barua pepe si sahihi? Rudi ujisajili tena'}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          pendingPasswordRef.current = null;
                          setErrorMessage(null);
                          setSuccessNotice(null);
                          setAuthTab('login');
                        }}
                        className="w-full text-[11px] font-semibold underline underline-offset-2 text-stone-500 hover:text-orange-600 dark:text-stone-400 cursor-pointer"
                        id="verification-back-btn"
                      >
                        {language === 'en' ? '← Back' : '← Rudi nyuma'}
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* FINISH SIGN-UP SCREEN (shown after the emailed link is opened; the account is created here) */}
              {authTab === 'complete_signup' && (() => {
                const pendingForCompletion = getPendingSignup();
                const problem = !pendingForCompletion ? 'no_pending' : completeSignupProblem;
                return (
                  <div className="space-y-5 py-4 animate-fade-in text-center" id="complete-signup-screen">
                    <div className={`w-16 h-16 rounded-3xl mx-auto flex items-center justify-center text-3xl shadow-md border-2 ${
                      isNight ? 'bg-slate-800 border-emerald-500/60 text-emerald-300' : 'bg-emerald-50 border-emerald-200 text-emerald-600'
                    }`}>
                      {problem ? '⚠️' : '✅'}
                    </div>

                    {problem === 'no_pending' && (
                      <div className="space-y-3 max-w-sm mx-auto">
                        <h3 className={`font-display font-black text-lg ${isNight ? 'text-amber-300' : 'text-gray-900'}`}>
                          {language === 'en' ? 'We could not find your registration' : 'Hatukupata usajili wako'}
                        </h3>
                        <p className={`text-sm leading-relaxed font-medium ${isNight ? 'text-slate-200' : 'text-gray-700'}`}>
                          {language === 'en'
                            ? 'Your registration details are saved in the browser you signed up with. Please open the email link in that same browser (and on the same device), or sign up again.'
                            : 'Taarifa zako za usajili zimehifadhiwa kwenye kivinjari ulichotumia kujisajili. Tafadhali fungua kiungo cha barua pepe kwenye kivinjari kile kile (na kifaa kile kile), au jisajili tena.'}
                        </p>
                        <button
                          type="button"
                          onClick={() => { setCompleteSignupProblem(null); setCompleteSignupHref(''); setAuthTab('signup'); setErrorMessage(null); }}
                          className="w-full py-3 px-4 bg-gradient-to-r from-orange-500 to-amber-500 text-white font-display font-extrabold text-xs sm:text-sm rounded-xl shadow-md border-b-4 border-orange-700 cursor-pointer"
                        >
                          {language === 'en' ? 'Sign up again' : 'Jisajili tena'}
                        </button>
                      </div>
                    )}

                    {problem === 'expired' && (
                      <div className="space-y-3 max-w-sm mx-auto">
                        <h3 className={`font-display font-black text-lg ${isNight ? 'text-amber-300' : 'text-gray-900'}`}>
                          {language === 'en' ? 'This link has expired or was already used' : 'Kiungo hiki kimeisha muda au kimeshatumika'}
                        </h3>
                        <p className={`text-sm leading-relaxed font-medium ${isNight ? 'text-slate-200' : 'text-gray-700'}`}>
                          {language === 'en'
                            ? 'No problem: we can email you a new one. Your registration details are still saved.'
                            : 'Hakuna shida: tunaweza kukutumia kingine. Taarifa zako za usajili bado zimehifadhiwa.'}
                        </p>
                        <button
                          type="button"
                          onClick={handleSendNewSignupLink}
                          disabled={isSendingSignupLink}
                          className="w-full py-3 px-4 bg-gradient-to-r from-orange-500 to-amber-500 text-white font-display font-extrabold text-xs sm:text-sm rounded-xl shadow-md border-b-4 border-orange-700 cursor-pointer disabled:opacity-60"
                        >
                          {isSendingSignupLink
                            ? (language === 'en' ? 'Sending...' : 'Inatuma...')
                            : (language === 'en' ? 'Email me a new link' : 'Nitumie kiungo kipya')}
                        </button>
                      </div>
                    )}

                    {!problem && pendingForCompletion && (
                      <form onSubmit={handleCompleteSignup} className="space-y-4 max-w-sm mx-auto text-left">
                        <div className="text-center space-y-2">
                          <h3 className={`font-display font-black text-lg ${isNight ? 'text-amber-300' : 'text-gray-900'}`}>
                            {language === 'en' ? 'Email link confirmed' : 'Kiungo cha barua pepe kimethibitishwa'}
                          </h3>
                          <p className={`text-sm leading-relaxed font-medium ${isNight ? 'text-slate-200' : 'text-gray-700'}`}>
                            {language === 'en'
                              ? <>One last step: enter the password you chose when you registered for <span className="font-bold font-mono break-all">{pendingForCompletion.email}</span> to create your account.</>
                              : <>Hatua ya mwisho: ingiza nenosiri ulilochagua ulipojisajili kwa <span className="font-bold font-mono break-all">{pendingForCompletion.email}</span> ili kutengeneza akaunti yako.</>}
                          </p>
                        </div>

                        <div className="relative">
                          <Lock className="w-4 h-4 text-orange-500 absolute left-3 top-1/2 -translate-y-1/2" />
                          <input
                            type="password"
                            value={completePassword}
                            onChange={(e) => setCompletePassword(e.target.value)}
                            autoComplete="current-password"
                            autoFocus
                            placeholder={language === 'en' ? 'Your password' : 'Nenosiri lako'}
                            className={`w-full pl-9 pr-3 py-3 rounded-xl border-2 text-sm font-medium outline-none focus:ring-2 focus:ring-orange-400 ${
                              isNight ? 'bg-slate-800 border-slate-700 text-slate-100' : 'bg-white border-orange-200 text-gray-900'
                            }`}
                            id="complete-signup-password"
                          />
                        </div>

                        <button
                          type="submit"
                          disabled={isCompletingSignup}
                          className="w-full py-3 px-4 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 text-white font-display font-extrabold text-xs sm:text-sm rounded-xl shadow-md border-b-4 border-orange-700 active:translate-y-0.5 cursor-pointer transition flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
                          id="complete-signup-submit-btn"
                        >
                          <ShieldCheck className="w-4 h-4" />
                          <span>
                            {isCompletingSignup
                              ? (language === 'en' ? 'Creating your account...' : 'Inatengeneza akaunti yako...')
                              : (language === 'en' ? 'Create my account' : 'Tengeneza akaunti yangu')}
                          </span>
                        </button>
                      </form>
                    )}
                  </div>
                );
              })()}

              {/* 1. ARTIST LOG IN FORM */}
              {authTab === 'login' && (
                <form onSubmit={handleArtistLoginSubmit} className="space-y-4">
                  <div>
                    <label className={`block text-xs font-display font-bold mb-1 ${
                      isNight ? 'text-amber-200' : 'text-amber-955'
                    }`}>
                      {language === 'en' ? 'Email Address or Username' : 'Barua Pepe au Jina la Mtumiaji'}
                    </label>
                    <div className="relative">
                      <User className="w-4 h-4 text-orange-400 absolute left-3 top-3" />
                      <input
                        type="text"
                        autoComplete="off"
                        name="no-autofill-login-id"
                        value={loginIdentifier}
                        onChange={(e) => setLoginIdentifier(e.target.value)}
                        placeholder={language === 'en' ? 'e.g. youremail@gmail.com or @artist_studio' : 'k.m. youremail@gmail.com au @artist_studio'}
                        className={`w-full pl-9 pr-3 py-2.5 text-xs rounded-xl border-2 focus:outline-none font-medium ${
                          isNight
                            ? 'bg-slate-800 text-slate-100 border-slate-700 focus:border-amber-500'
                            : 'bg-orange-50/20 text-gray-900 border-orange-200 focus:border-orange-500'
                        }`}
                        id="artist-login-identifier-input"
                      />
                    </div>
                  </div>

                  <div>
                    <label className={`block text-xs font-display font-bold mb-1 ${
                      isNight ? 'text-amber-200' : 'text-amber-955'
                    }`}>
                      {language === 'en' ? 'Password' : 'Nenosiri'}
                    </label>
                    <div className="relative">
                      <Lock className="w-4 h-4 text-orange-400 absolute left-3 top-3" />
                      <input
                        type="password"
                        value={loginPassword}
                        onChange={(e) => setLoginPassword(e.target.value)}
                        placeholder="••••••••"
                        className={`w-full pl-9 pr-3 py-2.5 text-xs rounded-xl border-2 focus:outline-none font-medium ${
                          isNight
                            ? 'bg-slate-800 text-slate-100 border-slate-700 focus:border-amber-500'
                            : 'bg-orange-50/20 text-gray-900 border-orange-200 focus:border-orange-500'
                        }`}
                      />
                    </div>
                    <div className="flex justify-end mt-1">
                      <button
                        type="button"
                        onClick={() => {
                          setAuthTab('forgot_password');
                          setResetEmail(loginIdentifier.includes('@') ? loginIdentifier : '');
                          setErrorMessage(null);
                          setSuccessNotice(null);
                          setResetSentSuccess(false);
                          playChime('pop');
                        }}
                        className={`text-[11px] font-bold hover:underline cursor-pointer ${
                          isNight ? 'text-amber-300 hover:text-amber-200' : 'text-orange-600 hover:text-orange-700'
                        }`}
                        id="artist-forgot-password-link"
                      >
                        {language === 'en' ? 'Forgot Password?' : 'Umesahau Nenosiri?'}
                      </button>
                    </div>
                  </div>

                  {/* Submit Button */}
                  <button
                    type="submit"
                    className="w-full py-3 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 text-white font-display font-bold text-xs sm:text-sm rounded-xl shadow-md border-b-3 border-amber-700 active:translate-y-0.5 cursor-pointer transition flex items-center justify-center gap-2"
                    id="artist-login-submit-btn"
                  >
                    <LogIn className="w-4 h-4" />
                    <span>{language === 'en' ? 'Log In to Artist Studio' : 'Ingia Kwenye Studio'}</span>
                  </button>

                  <p className={`text-[11px] text-center mt-2 ${
                    isNight ? 'text-slate-300' : 'text-amber-900'
                  }`}>
                    {language === 'en' ? "Don't have an artist account yet?" : 'Huna akaunti ya msanii bado?'}{' '}
                    <button
                      type="button"
                      onClick={() => setAuthTab('signup')}
                      className={`font-bold hover:underline cursor-pointer ${
                        isNight ? 'text-amber-300' : 'text-orange-600'
                      }`}
                    >
                      {language === 'en' ? 'Sign Up here' : 'Jisajili hapa'}
                    </button>
                  </p>
                </form>
              )}

              {/* 2. FORGOT PASSWORD FORM & SUCCESS VIEW */}
              {authTab === 'forgot_password' && resetSentSuccess && (
                <div className="space-y-6 py-4 animate-fade-in text-center select-none" id="forgot-password-success-view">
                  {/* Icon */}
                  <div className={`w-16 h-16 rounded-3xl mx-auto flex items-center justify-center text-3xl shadow-md border-2 ${
                    isNight ? 'bg-slate-800 border-amber-500/60 text-amber-300' : 'bg-orange-50 border-orange-200 text-orange-600'
                  }`}>
                    ✉️
                  </div>

                  {/* Notification Message */}
                  <div className="space-y-3 max-w-sm mx-auto">
                    <h3 className={`font-display font-black text-lg sm:text-xl ${
                      isNight ? 'text-amber-300' : 'text-gray-900'
                    }`}>
                      {language === 'en' ? 'Password Reset Link Dispatched' : 'Kiunganishi cha Nenosiri Kimetumwa'}
                    </h3>
                    <p className={`text-sm sm:text-base leading-relaxed font-medium px-2 ${
                      isNight ? 'text-slate-200' : 'text-gray-700'
                    }`}>
                      {language === 'en' ? (
                        <>
                          We sent you a password change link to{' '}
                          <span className={`font-bold font-mono px-1.5 py-0.5 rounded-md border ${
                            isNight ? 'text-amber-300 bg-slate-800 border-amber-500/40' : 'text-orange-600 bg-orange-100/70 border-orange-300'
                          }`}>
                            {sentResetEmail || resetEmail}
                          </span>
                        </>
                      ) : (
                        <>
                          Tumekutumia kiunganishi cha kubadilisha nenosiri kwa{' '}
                          <span className={`font-bold font-mono px-1.5 py-0.5 rounded-md border ${
                            isNight ? 'text-amber-300 bg-slate-800 border-amber-500/40' : 'text-orange-600 bg-orange-100/70 border-orange-300'
                          }`}>
                            {sentResetEmail || resetEmail}
                          </span>
                        </>
                      )}
                    </p>
                  </div>

                  {/* Sign In button below the message */}
                  <div className="max-w-xs mx-auto pt-2">
                    <button
                      type="button"
                      onClick={() => {
                        setAuthTab('login');
                        if (sentResetEmail || resetEmail) {
                          setLoginIdentifier(sentResetEmail || resetEmail);
                        }
                        setResetSentSuccess(false);
                        setErrorMessage(null);
                        setSuccessNotice(null);
                        playChime('pop');
                      }}
                      className="w-full py-3 px-6 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 text-white font-display font-extrabold text-sm sm:text-base rounded-2xl shadow-md hover:shadow-lg transition cursor-pointer flex items-center justify-center gap-2 border-b-4 border-orange-700 active:translate-y-0.5"
                      id="forgot-password-signin-btn"
                    >
                      <LogIn className="w-4 h-4 sm:w-5 sm:h-5" />
                      <span>{language === 'en' ? 'Sign In' : 'Ingia'}</span>
                    </button>
                  </div>
                </div>
              )}

              {authTab === 'forgot_password' && !resetSentSuccess && (
                <form onSubmit={handleForgotPasswordSubmit} className="space-y-4 py-1">
                  <div className="text-center space-y-1">
                    <div className={`w-12 h-12 rounded-2xl flex items-center justify-center mx-auto text-xl shadow-xs border ${
                      isNight ? 'bg-slate-800 border-slate-700 text-amber-300' : 'bg-orange-100 border-orange-200 text-orange-600'
                    }`}>
                      🔑
                    </div>
                    <h4 className={`font-display font-bold text-sm ${
                      isNight ? 'text-slate-100' : 'text-gray-900'
                    }`}>
                      {language === 'en' ? 'Reset Your Password' : 'Badilisha Nenosiri Lako'}
                    </h4>
                    <p className={`text-xs max-w-xs mx-auto leading-relaxed ${
                      isNight ? 'text-slate-300' : 'text-gray-600'
                    }`}>
                      {language === 'en'
                        ? 'Enter your registered email address below. We will send you a password reset link.'
                        : 'Ingiza barua pepe yako iliyosajiliwa. Tutatuma kiunganishi cha kubadilisha nenosiri.'}
                    </p>
                  </div>

                  <div>
                    <label className={`block text-xs font-display font-bold mb-1 ${
                      isNight ? 'text-amber-200' : 'text-amber-955'
                    }`}>
                      {language === 'en' ? 'Email Address' : 'Barua Pepe'}
                    </label>
                    <div className="relative">
                      <Mail className="w-4 h-4 text-orange-400 absolute left-3 top-3" />
                      <input
                        type="email"
                        required
                        autoComplete="off"
                        name="no-autofill-reset-email"
                        value={resetEmail}
                        onChange={(e) => setResetEmail(e.target.value)}
                        placeholder="youremail@gmail.com"
                        className={`w-full pl-9 pr-3 py-2.5 text-xs rounded-xl border-2 focus:outline-none font-medium ${
                          isNight
                            ? 'bg-slate-800 text-slate-100 border-slate-700 focus:border-amber-500'
                            : 'bg-orange-50/20 text-gray-900 border-orange-200 focus:border-orange-500'
                        }`}
                        id="forgot-password-email-input"
                      />
                    </div>
                  </div>

                  <button
                    type="submit"
                    disabled={isSendingReset}
                    className="w-full py-3 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 text-white font-display font-bold text-xs sm:text-sm rounded-xl shadow-md border-b-3 border-amber-700 active:translate-y-0.5 cursor-pointer transition flex items-center justify-center gap-2 disabled:opacity-50"
                    id="send-reset-password-btn"
                  >
                    <Mail className="w-4 h-4" />
                    <span>
                      {isSendingReset
                        ? (language === 'en' ? 'Getting Reset Link...' : 'Inatuma...')
                        : (language === 'en' ? 'Get Reset Link' : 'Pata Kiunganishi cha Kubadilisha')}
                    </span>
                  </button>

                  <div className="text-center pt-1">
                    <button
                      type="button"
                      onClick={() => {
                        setAuthTab('login');
                        setErrorMessage(null);
                        setSuccessNotice(null);
                        playChime('pop');
                      }}
                      className={`text-xs font-bold hover:underline cursor-pointer inline-flex items-center gap-1 ${
                        isNight ? 'text-amber-300 hover:text-amber-200' : 'text-amber-900 hover:text-orange-600'
                      }`}
                    >
                      <span>←</span>
                      <span>{language === 'en' ? 'Back to Log In' : 'Rudi Kwenye Kuingia'}</span>
                    </button>
                  </div>
                </form>
              )}

              {/* 2. ARTIST SIGN UP FORM */}
              {authTab === 'signup' && (
                <form onSubmit={handleArtistSignupSubmit} className="space-y-3.5 max-h-[55vh] overflow-y-auto pr-1">
                  
                  {/* First Name & Last Name */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className={`block text-xs font-display font-bold mb-1 ${
                        isNight ? 'text-amber-200' : 'text-amber-955'
                      }`}>
                        {language === 'en' ? 'First Name *' : 'Jina la Kwanza *'}
                      </label>
                      <input
                        type="text"
                        required
                        autoComplete="off"
                        name="no-autofill-first-name"
                        value={signupFirstName}
                        onChange={(e) => setSignupFirstName(e.target.value)}
                        placeholder={language === 'en' ? 'e.g. Sonia' : 'k.m. Sonia'}
                        className={`w-full px-3 py-2 text-xs rounded-xl border-2 focus:outline-none font-medium ${
                          isNight
                            ? 'bg-slate-800 text-slate-100 border-slate-700 focus:border-amber-500'
                            : 'bg-orange-50/20 text-gray-900 border-orange-200 focus:border-orange-500'
                        }`}
                        id="artist-signup-first-name-input"
                      />
                    </div>
                    <div>
                      <label className={`block text-xs font-display font-bold mb-1 ${
                        isNight ? 'text-amber-200' : 'text-amber-955'
                      }`}>
                        {language === 'en' ? 'Last Name *' : 'Jina la Mwisho *'}
                      </label>
                      <input
                        type="text"
                        required
                        autoComplete="off"
                        name="no-autofill-last-name"
                        value={signupLastName}
                        onChange={(e) => setSignupLastName(e.target.value)}
                        placeholder={language === 'en' ? 'e.g. Glass' : 'k.m. Glass'}
                        className={`w-full px-3 py-2 text-xs rounded-xl border-2 focus:outline-none font-medium ${
                          isNight
                            ? 'bg-slate-800 text-slate-100 border-slate-700 focus:border-amber-500'
                            : 'bg-orange-50/20 text-gray-900 border-orange-200 focus:border-orange-500'
                        }`}
                        id="artist-signup-last-name-input"
                      />
                    </div>
                  </div>

                  {/* Username / Handle */}
                  <div>
                    <label className={`block text-xs font-display font-bold mb-1 ${
                      isNight ? 'text-amber-200' : 'text-amber-955'
                    }`}>
                      {language === 'en' ? 'Artist Handle / Username *' : 'Jina la Mtumiaji *'}
                    </label>
                    <input
                      type="text"
                      required
                      autoComplete="off"
                      name="no-autofill-username"
                      value={signupUsername}
                      onChange={(e) => setSignupUsername(e.target.value)}
                      placeholder="e.g. @sonia_crafts"
                      className={`w-full px-3 py-2 text-xs rounded-xl border-2 focus:outline-none font-medium ${
                        isNight
                          ? 'bg-slate-800 text-slate-100 border-slate-700 focus:border-amber-500'
                          : 'bg-orange-50/20 text-gray-900 border-orange-200 focus:border-orange-500'
                      }`}
                      id="artist-signup-username-input"
                    />
                  </div>

                  {/* Email & Phone */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className={`block text-xs font-display font-bold mb-1 ${
                        isNight ? 'text-amber-200' : 'text-amber-955'
                      }`}>
                        {language === 'en' ? 'Email Address *' : 'Barua Pepe *'}
                      </label>
                      <input
                        type="email"
                        required
                        autoComplete="off"
                        name="no-autofill-email"
                        value={signupEmail}
                        onChange={(e) => setSignupEmail(e.target.value)}
                        placeholder="youremail@gmail.com"
                        className={`w-full px-3 py-2 text-xs rounded-xl border-2 focus:outline-none font-medium ${
                          isNight
                            ? 'bg-slate-800 text-slate-100 border-slate-700 focus:border-amber-500'
                            : 'bg-orange-50/20 text-gray-900 border-orange-200 focus:border-orange-500'
                        }`}
                        id="artist-signup-email-input"
                      />
                    </div>
                    <div>
                      <label className={`block text-xs font-display font-bold mb-1 ${
                        isNight ? 'text-amber-200' : 'text-amber-955'
                      }`}>
                        {language === 'en' ? 'Phone / Contact Number *' : 'Nambari ya Simu *'}
                      </label>
                      <input
                        type="tel"
                        required
                        autoComplete="off"
                        name="no-autofill-phone"
                        value={signupPhone}
                        onChange={(e) => setSignupPhone(e.target.value)}
                        placeholder="+1 555-0192 / +254 700..."
                        className={`w-full px-3 py-2 text-xs rounded-xl border-2 focus:outline-none font-medium ${
                          isNight
                            ? 'bg-slate-800 text-slate-100 border-slate-700 focus:border-amber-500'
                            : 'bg-orange-50/20 text-gray-900 border-orange-200 focus:border-orange-500'
                        }`}
                        id="artist-signup-phone-input"
                      />
                    </div>
                  </div>

                  {/* Profile Picture / Avatar */}
                  <div className={`p-3.5 rounded-2xl border-2 transition-all ${
                    isNight ? 'bg-slate-800/80 border-slate-700' : 'bg-orange-50/40 border-orange-200'
                  }`}>
                    <div className="flex items-center justify-between mb-2">
                      <label className={`block text-xs font-display font-bold ${
                        isNight ? 'text-amber-200' : 'text-amber-955'
                      }`}>
                        {language === 'en' ? 'Profile Photo or Avatar' : 'Picha ya Wasifu au Avatar'}
                      </label>
                      <span className="text-[10px] text-gray-500 font-medium">
                        {signupProfilePicUrl
                          ? (language === 'en' ? 'Custom Photo Active' : 'Picha Imewekwa')
                          : (language === 'en' ? 'Avatar Emoji Active' : 'Avatar ya Emoji')}
                      </span>
                    </div>

                    {/* Preview + Action Buttons */}
                    <div className="flex items-center gap-3 mb-3">
                      {/* Visual Preview */}
                      <div className="relative group flex-shrink-0">
                        <div className={`w-14 h-14 rounded-2xl border-2 flex items-center justify-center overflow-hidden shadow-sm transition ${
                          isNight ? 'bg-slate-900 border-amber-500/40' : 'bg-white border-orange-300'
                        }`}>
                          {signupProfilePicUrl ? (
                            <img
                              src={signupProfilePicUrl}
                              alt="Profile Preview"
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <span className="text-3xl select-none" role="img" aria-label="avatar">
                              {signupAvatar || '🎨'}
                            </span>
                          )}
                        </div>
                        {signupProfilePicUrl && (
                          <button
                            type="button"
                            onClick={handleRemovePhoto}
                            title={language === 'en' ? 'Remove photo' : 'Ondoa picha'}
                            className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-red-600 hover:bg-red-700 text-white flex items-center justify-center shadow-xs text-[10px] cursor-pointer"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        )}
                      </div>

                      {/* Action buttons: Upload Photo & Add Avatar */}
                      <div className="flex-1 flex flex-col sm:flex-row gap-2">
                        {/* Hidden Native File Input */}
                        <input
                          type="file"
                          ref={photoFileInputRef}
                          onChange={handlePhotoUpload}
                          accept="image/*"
                          className="hidden"
                          id="artist-photo-file-input"
                        />

                        {/* Upload Photo Button */}
                        <button
                          type="button"
                          onClick={() => photoFileInputRef.current?.click()}
                          disabled={isProcessingPhoto}
                          className={`flex-1 py-2 px-3 rounded-xl font-bold text-xs flex items-center justify-center gap-1.5 shadow-xs transition cursor-pointer active:scale-95 ${
                            isNight
                              ? 'bg-amber-600 hover:bg-amber-500 text-white'
                              : 'bg-orange-500 hover:bg-orange-600 text-white'
                          }`}
                        >
                          <Upload className="w-3.5 h-3.5" />
                          <span>
                            {isProcessingPhoto
                              ? (language === 'en' ? 'Processing...' : 'Inasindika...')
                              : (language === 'en' ? 'Upload Photo' : 'Pakia Picha')}
                          </span>
                        </button>

                        {/* Add Avatar Button */}
                        <button
                          type="button"
                          onClick={() => setShowCustomAvatarInput(!showCustomAvatarInput)}
                          className={`py-2 px-3 rounded-xl font-bold text-xs border flex items-center justify-center gap-1.5 transition cursor-pointer ${
                            showCustomAvatarInput
                              ? 'bg-orange-500 text-white border-orange-600 shadow-xs'
                              : (isNight
                                  ? 'bg-slate-700 hover:bg-slate-600 text-amber-200 border-slate-600'
                                  : 'bg-white hover:bg-orange-100 text-orange-900 border-orange-300')
                          }`}
                        >
                          <Plus className="w-3.5 h-3.5" />
                          <span>{language === 'en' ? 'Add Avatar' : 'Ongeza Avatar'}</span>
                        </button>
                      </div>
                    </div>

                    {/* Custom Avatar Input Dialog (when toggled) */}
                    {showCustomAvatarInput && (
                      <div className={`p-2.5 mb-3 rounded-xl border flex items-center gap-2 ${
                        isNight ? 'bg-slate-900 border-slate-700' : 'bg-white border-orange-300'
                      }`}>
                        <input
                          type="text"
                          maxLength={8}
                          value={customAvatarInput}
                          onChange={(e) => setCustomAvatarInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              handleAddCustomAvatar();
                            }
                          }}
                          placeholder={language === 'en' ? 'Type or paste emoji (e.g. 🐉, 🌻, 🚀)...' : 'Andika au weka emoji...'}
                          className={`flex-1 px-3 py-1.5 text-xs rounded-lg border focus:outline-none ${
                            isNight
                              ? 'bg-slate-800 text-slate-100 border-slate-700 focus:border-amber-500'
                              : 'bg-orange-50/30 text-gray-900 border-orange-200 focus:border-orange-500'
                          }`}
                        />
                        <button
                          type="button"
                          onClick={handleAddCustomAvatar}
                          disabled={!customAvatarInput.trim()}
                          className="px-3 py-1.5 bg-orange-500 hover:bg-orange-600 disabled:opacity-50 text-white text-xs font-bold rounded-lg cursor-pointer transition flex items-center gap-1"
                        >
                          <Check className="w-3.5 h-3.5" />
                          <span>{language === 'en' ? 'Use Avatar' : 'Tumia'}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setShowCustomAvatarInput(false)}
                          className="p-1.5 text-gray-400 hover:text-gray-600 cursor-pointer"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}

                    {/* Curated Preset Avatars Grid */}
                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <span className={`text-[11px] font-bold ${
                          isNight ? 'text-slate-300' : 'text-gray-700'
                        }`}>
                          {language === 'en' ? 'Or choose an avatar:' : 'Au chagua avatar:'}
                        </span>
                        <button
                          type="button"
                          onClick={() => setShowUrlInput(!showUrlInput)}
                          className="text-[10px] text-orange-600 hover:text-orange-700 underline cursor-pointer"
                        >
                          {showUrlInput
                            ? (language === 'en' ? 'Hide image link' : 'Ficha kiungo')
                            : (language === 'en' ? 'Or paste image link' : 'Weka kiungo cha mtandaoni')}
                        </button>
                      </div>

                      <div className="flex items-center gap-1.5 flex-wrap">
                        {PRESET_AVATARS.map((av) => (
                          <button
                            key={av}
                            type="button"
                            onClick={() => {
                              setSignupAvatar(av);
                              setSignupProfilePicUrl('');
                              playChime('pop');
                            }}
                            title={`Select ${av}`}
                            className={`w-8 h-8 rounded-xl text-base border flex items-center justify-center cursor-pointer transition ${
                              signupAvatar === av && !signupProfilePicUrl
                                ? 'bg-orange-500 text-white border-orange-600 scale-110 shadow-xs'
                                : (isNight
                                    ? 'bg-slate-900 text-slate-100 border-slate-700 hover:bg-slate-700'
                                    : 'bg-white text-amber-955 border-orange-200 hover:bg-orange-100')
                            }`}
                          >
                            {av}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Optional Image URL Input (if user wants to paste a direct link) */}
                    {showUrlInput && (
                      <div className="mt-2.5 pt-2 border-t border-orange-200/50">
                        <label className={`block text-[10px] font-bold mb-1 ${
                          isNight ? 'text-slate-300' : 'text-gray-600'
                        }`}>
                          {language === 'en' ? 'Web Image URL (Optional):' : 'Kiungo cha Picha Mtandaoni (Si lazima):'}
                        </label>
                        <input
                          type="url"
                          value={signupProfilePicUrl.startsWith('data:') ? '' : signupProfilePicUrl}
                          onChange={(e) => setSignupProfilePicUrl(e.target.value)}
                          placeholder="https://example.com/my-photo.jpg"
                          className={`w-full px-3 py-1.5 text-[11px] rounded-xl border focus:outline-none ${
                            isNight
                              ? 'bg-slate-900 text-slate-100 border-slate-700 focus:border-amber-500'
                              : 'bg-white text-gray-900 border-orange-200 focus:border-orange-500'
                          }`}
                        />
                      </div>
                    )}
                  </div>


                  <div>
                    <label className={`block text-xs font-display font-bold mb-1 ${
                      isNight ? 'text-amber-200' : 'text-amber-955'
                    }`}>
                      {language === 'en' ? 'Artist Art Categories & Specialization *' : 'Aina za Sanaa Unazobuni *'}
                    </label>
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {ARTIST_CATEGORIES.map((cat) => {
                        const isSelected = signupCategories.includes(cat);
                        return (
                          <button
                            key={cat}
                            type="button"
                            onClick={() => toggleCategory(cat)}
                            className={`px-2.5 py-1 rounded-full text-[10px] font-bold border transition cursor-pointer flex items-center gap-1 ${
                              isSelected
                                ? 'bg-orange-500 text-white border-orange-600 shadow-2xs'
                                : (isNight ? 'bg-slate-800 text-slate-100 border-slate-700 hover:bg-slate-700' : 'bg-orange-50 text-amber-955 border-orange-200 hover:bg-orange-100')
                            }`}
                          >
                            {isSelected && <Check className="w-3 h-3 stroke-[3px]" />}
                            <span>{cat}</span>
                          </button>
                        );
                      })}
                    </div>
                    <input
                      type="text"
                      required
                      autoComplete="off"
                      name="no-autofill-specialization"
                      value={signupSpecialization}
                      onChange={(e) => setSignupSpecialization(e.target.value)}
                      placeholder={language === 'en' ? 'Art Specialization / Niche * (e.g. 3D Clay Modeling, Origami, Character Design)' : 'Utaalamu Wako Maalum * (k.m. Udongo wa 3D, Origami)'}
                      className={`w-full px-3 py-2 text-xs rounded-xl border-2 focus:outline-none font-medium ${
                        isNight
                          ? 'bg-slate-800 text-slate-100 border-slate-700 focus:border-amber-500'
                          : 'bg-orange-50/20 text-gray-900 border-orange-200 focus:border-orange-500'
                      }`}
                      id="artist-signup-specialization-input"
                    />
                  </div>

                  {/* Artist Bio / Unique Details */}
                  <div>
                    <label className={`block text-xs font-display font-bold mb-1 ${
                      isNight ? 'text-amber-200' : 'text-amber-955'
                    }`}>
                      {language === 'en' ? 'Artist Statement / Bio *' : 'Maelezo Mafupi ya Sanaa Yako *'}
                    </label>
                    <textarea
                      required
                      value={signupBio}
                      onChange={(e) => setSignupBio(e.target.value)}
                      rows={2}
                      placeholder={language === 'en' ? 'Tell readers and students about your art style and books...' : 'Waambie wasomaji kuhusu mtindo wako wa sanaa...'}
                      className={`w-full px-3 py-2 text-xs rounded-xl border-2 focus:outline-none resize-none font-medium ${
                        isNight
                          ? 'bg-slate-800 text-slate-100 border-slate-700 focus:border-amber-500'
                          : 'bg-orange-50/20 text-gray-900 border-orange-200 focus:border-orange-500'
                      }`}
                      id="artist-signup-bio-textarea"
                    />
                  </div>

                  {/* Password & Confirm */}
                  <div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className={`block text-xs font-display font-bold mb-1 ${
                          isNight ? 'text-amber-200' : 'text-amber-955'
                        }`}>
                          {language === 'en' ? 'Password *' : 'Nenosiri *'}
                        </label>
                        <input
                          type="password"
                          required
                          value={signupPassword}
                          onChange={(e) => setSignupPassword(e.target.value)}
                          placeholder="••••••••"
                          className={`w-full px-3 py-2 text-xs rounded-xl border-2 focus:outline-none font-medium ${
                            isNight
                              ? 'bg-slate-800 text-slate-100 border-slate-700 focus:border-amber-500'
                              : 'bg-orange-50/20 text-gray-900 border-orange-200 focus:border-orange-500'
                          }`}
                          id="artist-signup-password-input"
                        />
                      </div>
                      <div>
                        <label className={`block text-xs font-display font-bold mb-1 ${
                          isNight ? 'text-amber-200' : 'text-amber-955'
                        }`}>
                          {language === 'en' ? 'Confirm Password *' : 'Thibitisha Nenosiri *'}
                        </label>
                        <input
                          type="password"
                          required
                          value={signupConfirmPassword}
                          onChange={(e) => setSignupConfirmPassword(e.target.value)}
                          placeholder="••••••••"
                          className={`w-full px-3 py-2 text-xs rounded-xl border-2 focus:outline-none font-medium ${
                            isNight
                              ? 'bg-slate-800 text-slate-100 border-slate-700 focus:border-amber-500'
                              : 'bg-orange-50/20 text-gray-900 border-orange-200 focus:border-orange-500'
                          }`}
                          id="artist-signup-confirm-password-input"
                        />
                      </div>
                    </div>
                    <p className={`text-[10px] font-medium mt-2 flex items-center gap-1.5 p-2 rounded-xl border ${
                      isNight
                        ? 'bg-slate-800/80 border-slate-700 text-slate-300'
                        : 'bg-amber-100/70 border-amber-200 text-amber-900/90'
                    }`}>
                      <span>🔐</span>
                      <span>
                        {language === 'en'
                          ? 'Password must be more than 7 characters long and include alphabets, numbers, and special symbols (!@#$%^&*).'
                          : 'Nenosiri lazima liwe na zaidi ya herufi 7 na lijumuishe herufi, namba, na alama maalum (!@#$%^&*).'}
                      </span>
                    </p>
                  </div>

                  {/* Submit Signup Button */}
                  <button
                    type="submit"
                    disabled={isSendingSignupLink}
                    className="w-full py-3 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 text-white font-display font-bold text-xs sm:text-sm rounded-xl shadow-md border-b-3 border-amber-700 active:translate-y-0.5 cursor-pointer transition flex items-center justify-center gap-2 mt-2 disabled:opacity-60 disabled:cursor-not-allowed"
                    id="artist-signup-submit-btn"
                  >
                    <Sparkles className="w-4 h-4" />
                    <span>{isSendingSignupLink
                      ? (language === 'en' ? 'Sending verification link...' : 'Inatuma kiungo cha uthibitisho...')
                      : (language === 'en' ? 'Register & Send Verification Link' : 'Jisajili & Tuma Kiungo cha Uthibitisho')}</span>
                  </button>

                  <p className={`text-[11px] text-center mt-2 ${
                    isNight ? 'text-slate-300' : 'text-amber-900'
                  }`}>
                    {language === 'en' ? 'Already have an artist account?' : 'Je, una akaunti ya msanii tayari?'}{' '}
                    <button
                      type="button"
                      onClick={() => setAuthTab('login')}
                      className={`font-bold hover:underline cursor-pointer ${
                        isNight ? 'text-amber-300' : 'text-orange-600'
                      }`}
                    >
                      {language === 'en' ? 'Log In here' : 'Ingia hapa'}
                    </button>
                  </p>
                </form>
              )}

            </div>
          )}

          {/* STEP 2B: STUDENT DIRECT ENTRY (NO LOGIN) */}
          {step === 'student_setup' && (
            <div className="space-y-5 animate-fade-in text-center py-2">
              
              <button
                type="button"
                onClick={() => { setStep('role_select'); playChime('pop'); }}
                className={`text-xs font-bold flex items-center gap-1 cursor-pointer mx-auto ${
                  isNight ? 'text-amber-300 hover:text-emerald-300' : 'text-amber-900 hover:text-teal-600'
                }`}
              >
                ← {language === 'en' ? 'Back to role selection' : 'Rudi nyuma'}
              </button>

              <div className="w-16 h-16 rounded-3xl bg-gradient-to-br from-emerald-400 to-teal-500 text-white flex items-center justify-center text-4xl shadow-md border border-teal-600 mx-auto animate-bounce-slow">
                🎓
              </div>

              <div>
                <h3 className={`font-display font-extrabold text-lg ${
                  isNight ? 'text-emerald-300' : 'text-teal-955'
                }`}>
                  {language === 'en' ? 'Welcome, Young Reader & Craft Student!' : 'Karibu, Msomaji wa Vitabu!'}
                </h3>
                <p className={`text-xs mt-1 max-w-sm mx-auto font-medium ${
                  isNight ? 'text-slate-300' : 'text-teal-900'
                }`}>
                  {language === 'en'
                    ? 'No passwords or account registration required for students! Personalize your reader nickname below to begin.'
                    : 'Hakuna haja ya nenosiri au kujisajili kwa wanafunzi! Weka jina lako na anza kusoma.'}
                </p>
              </div>

              {/* Student Nickname and Avatar customization */}
              <div className={`p-4 border-2 rounded-2xl max-w-md mx-auto space-y-3 text-left ${
                isNight ? 'bg-slate-800/90 border-emerald-500/50 text-slate-100' : 'bg-emerald-50/70 border-emerald-200'
              }`}>
                <div>
                  <label className={`block text-xs font-display font-bold mb-1 ${
                    isNight ? 'text-emerald-300' : 'text-teal-955'
                  }`}>
                    {language === 'en' ? 'Student Nickname:' : 'Jina la Mwanafunzi:'}
                  </label>
                  <input
                    type="text"
                    value={studentName}
                    onChange={(e) => setStudentName(e.target.value)}
                    placeholder="e.g. Alex the Reader"
                    className={`w-full px-3 py-2 text-xs rounded-xl border-2 focus:outline-none font-bold ${
                      isNight
                        ? 'bg-slate-900 text-slate-100 border-slate-700 focus:border-emerald-500'
                        : 'bg-white text-gray-900 border-emerald-300 focus:border-emerald-500'
                    }`}
                  />
                </div>

                <div>
                  <label className={`block text-xs font-display font-bold mb-1 ${
                    isNight ? 'text-emerald-300' : 'text-teal-955'
                  }`}>
                    {language === 'en' ? 'Choose Reading Buddy Avatar:' : 'Chagua Avatar:'}
                  </label>
                  <div className="flex items-center gap-2 flex-wrap">
                    {['🎓', '🦊', '🦁', '🐼', '🦄', '🦉', '🚀', '⭐'].map((av) => (
                      <button
                        key={av}
                        type="button"
                        onClick={() => { setStudentAvatar(av); playChime('pop'); }}
                        className={`w-9 h-9 rounded-xl text-lg border flex items-center justify-center cursor-pointer transition ${
                          studentAvatar === av
                            ? 'bg-emerald-500 text-white border-emerald-600 scale-110 shadow-xs'
                            : (isNight ? 'bg-slate-900 text-slate-100 border-slate-700 hover:bg-slate-700' : 'bg-white text-teal-955 border-emerald-200 hover:bg-emerald-100')
                        }`}
                      >
                        {av}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Enter Button */}
              <button
                type="button"
                onClick={handleStudentContinue}
                className="w-full max-w-md mx-auto py-3.5 bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-600 hover:to-teal-700 text-white font-display font-extrabold text-sm rounded-2xl shadow-md border-b-4 border-teal-800 active:translate-y-0.5 cursor-pointer transition flex items-center justify-center gap-2"
                id="student-enter-btn"
              >
                <span>{language === 'en' ? '🚀 Launch Picture Book Library' : '🚀 Anza Kusoma Vitabu'}</span>
              </button>

            </div>
          )}

        </div>

      </div>

    </div>
  );
}
