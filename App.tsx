import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Menu, X } from 'lucide-react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { LandingPage } from './pages/LandingPage';
import { AuthPage } from './pages/AuthPage';
import { ReportComplaintPage } from './pages/ReportComplaintPage';
import { TrackComplaintPage } from './pages/TrackComplaintPage';
import { LiveFleetMapPage } from './pages/LiveFleetMapPage';
import { AwarenessAndAiPage } from './pages/AwarenessAndAiPage';
import { Dashboards } from './pages/Dashboards';
import { VoiceAssistantWidget } from './components/VoiceAssistantWidget';
import type { LanguageCode } from './types';

function AppShell() {
  const { t, i18n } = useTranslation();
  const { user, logout, changeLanguage, unreadCount } = useAuth();

  const [route, setRoute] = useState<string>(() => window.location.pathname + window.location.search);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [quotaExceeded, setQuotaExceeded] = useState(false);
  const [prefill, setPrefill] = useState<{ ward?: number; category?: string; code?: string } | null>(null);

  useEffect(() => {
    const onPopState = () => setRoute(window.location.pathname + window.location.search);
    const onQuota = () => setQuotaExceeded(true);
    window.addEventListener('popstate', onPopState);
    window.addEventListener('gmp-quota-exceeded', onQuota);
    return () => {
      window.removeEventListener('popstate', onPopState);
      window.removeEventListener('gmp-quota-exceeded', onQuota);
    };
  }, []);

  const navigate = (path: string, nextPrefill?: { ward?: number; category?: string; code?: string }) => {
    if (nextPrefill) setPrefill(nextPrefill);
    window.history.pushState({}, '', path);
    setRoute(path);
    setMobileOpen(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const [pathname, searchStr] = route.split('?');
  const searchParams = new URLSearchParams(searchStr || '');
  const trackCodeParam = searchParams.get('code') || prefill?.code;

  const navItems = [
    { path: '/', label: t('nav.home') },
    { path: '/map', label: t('nav.liveMap') },
    { path: '/report', label: t('nav.report') },
    { path: '/track', label: t('nav.track') },
    { path: '/awareness', label: t('nav.aiClassifier') },
  ];

  const renderPage = () => {
    switch (pathname) {
      case '/map':
      case '/vehicles':
      case '/routes':
        return <LiveFleetMapPage quotaExceeded={quotaExceeded} />;
      case '/report':
        return <ReportComplaintPage prefill={prefill} onNavigate={navigate} quotaExceeded={quotaExceeded} />;
      case '/track':
        return <TrackComplaintPage initialCode={trackCodeParam || undefined} />;
      case '/ai-classifier':
      case '/awareness':
        return <AwarenessAndAiPage onNavigate={navigate} quotaExceeded={quotaExceeded} />;
      case '/login':
      case '/register':
        return <AuthPage onSuccess={() => navigate('/dashboard')} />;
      case '/dashboard':
        return <Dashboards onNavigate={navigate} />;
      default:
        return <LandingPage onNavigate={navigate} />;
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      {quotaExceeded && (
        <div className="bg-amber-50 border-b border-amber-200 text-amber-900 px-4 py-2.5 text-xs md:text-sm text-center sticky top-0 z-50 shadow-sm">
          <span>
            Google Maps Platform quota reached. If you are the app owner, visit{' '}
            <a
              href="https://developers.google.com/maps/ai/ai-studio?utm_campaign=gmp_mcp_codeassist_v1_aistudio#quota_exceeded_errors"
              target="_blank"
              rel="noopener noreferrer"
              className="underline font-semibold text-amber-950 hover:text-amber-800"
            >
              maps developer site
            </a>{' '}
            for instructions to update your account.
          </span>
        </div>
      )}

      {/* Top Navigation Bar — Three-Zone Layout */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-30">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-8">
          {/* Zone 1: Single-element wordmark */}
          <a
            href="/"
            onClick={(e) => {
              e.preventDefault();
              navigate('/');
            }}
            className="font-display text-xl font-extrabold tracking-tight text-emerald-800 whitespace-nowrap shrink-0"
          >
            {t('brand')}
          </a>

          {/* Zone 2: Concise single-line nav links */}
          <nav className="hidden lg:flex items-center gap-6 text-sm font-medium text-slate-600">
            {navItems.map((item) => {
              const active = pathname === item.path;
              return (
                <a
                  key={item.path}
                  href={item.path}
                  onClick={(e) => {
                    e.preventDefault();
                    navigate(item.path);
                  }}
                  className={`whitespace-nowrap shrink-0 transition-colors hover:text-slate-900 ${
                    active ? 'text-emerald-700 font-semibold' : ''
                  }`}
                >
                  {item.label}
                </a>
              );
            })}
          </nav>

          {/* Zone 3: Language + Primary Action */}
          <div className="hidden lg:flex items-center gap-3 shrink-0">
            <select
              value={i18n.language}
              onChange={(e) => changeLanguage(e.target.value as LanguageCode)}
              aria-label="Language Selector"
              className="px-2.5 py-1.5 text-xs font-medium bg-slate-50 border border-slate-200 rounded-lg text-slate-700"
            >
              <option value="en">EN</option>
              <option value="kn">ಕನ್ನಡ</option>
              <option value="hi">हिन्दी</option>
              <option value="mr">मराठी</option>
            </select>

            {user ? (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => navigate('/dashboard')}
                  className="px-4 py-2 rounded-lg bg-emerald-700 text-white text-xs font-semibold hover:bg-emerald-800 transition-colors whitespace-nowrap shrink-0"
                >
                  {t('nav.dashboard')} {unreadCount > 0 ? `(${unreadCount})` : ''}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    logout();
                    navigate('/');
                  }}
                  className="px-3 py-2 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
                >
                  {t('nav.signOut')}
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => navigate('/login')}
                className="px-4 py-2 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
              >
                {t('nav.signIn')}
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={() => setMobileOpen(!mobileOpen)}
            className="lg:hidden p-2 rounded-lg text-slate-700 hover:bg-slate-100"
            aria-label="Toggle Menu"
          >
            {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>

        {/* Mobile Drawer */}
        {mobileOpen && (
          <div className="lg:hidden bg-white border-t border-slate-200 px-4 py-4 space-y-3">
            <div className="flex flex-col space-y-2">
              {navItems.map((item) => (
                <button
                  key={item.path}
                  type="button"
                  onClick={() => navigate(item.path)}
                  className="text-left py-2 text-sm font-medium text-slate-700 hover:text-emerald-700"
                >
                  {item.label}
                </button>
              ))}
            </div>
            <div className="pt-3 border-t border-slate-100 flex items-center justify-between gap-3">
              <select
                value={i18n.language}
                onChange={(e) => changeLanguage(e.target.value as LanguageCode)}
                className="px-2.5 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg"
              >
                <option value="en">English</option>
                <option value="kn">ಕನ್ನಡ</option>
                <option value="hi">हिन्दी</option>
                <option value="mr">मराठी</option>
              </select>
              {user ? (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => navigate('/dashboard')}
                    className="px-4 py-2 rounded-lg bg-emerald-700 text-white text-xs font-semibold"
                  >
                    {t('nav.dashboard')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      logout();
                      navigate('/');
                    }}
                    className="px-3 py-2 rounded-lg border border-slate-200 text-xs font-medium"
                  >
                    {t('nav.signOut')}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => navigate('/login')}
                  className="px-4 py-2 rounded-lg bg-slate-900 text-white text-xs font-semibold"
                >
                  {t('nav.signIn')}
                </button>
              )}
            </div>
          </div>
        )}
      </header>

      <main className="flex-1">{renderPage()}</main>

      <footer className="bg-white border-t border-slate-200 py-8 mt-12">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-wrap items-center justify-between gap-4 text-xs text-slate-500">
          <div>
            <span className="font-display font-bold text-slate-900 mr-2">SANITRACK</span>
            <span>{t('tagline')} · Belagavi Municipal Waste Monitoring System</span>
          </div>
          <div className="flex flex-wrap items-center gap-5">
            <button type="button" onClick={() => navigate('/map')} className="hover:text-slate-900">
              {t('nav.liveMap')}
            </button>
            <button type="button" onClick={() => navigate('/report')} className="hover:text-slate-900">
              {t('nav.report')}
            </button>
            <button type="button" onClick={() => navigate('/track')} className="hover:text-slate-900">
              {t('nav.track')}
            </button>
            <button type="button" onClick={() => navigate('/awareness')} className="hover:text-slate-900">
              {t('nav.awareness')}
            </button>
          </div>
        </div>
      </footer>

      <VoiceAssistantWidget currentPath={pathname} onNavigate={navigate} />
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppShell />
    </AuthProvider>
  );
}
