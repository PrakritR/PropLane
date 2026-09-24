/** Inline boot scripts for root layout — keep as plain strings for next/script. */

export const THEME_BOOTSTRAP_SCRIPT = `(function(){try{var p=location.pathname||'/';if(!/^\\/(portal|resident|admin|vendor|auth)(\\/|$)/.test(p)){document.documentElement.setAttribute('data-theme','light');return;}var t=localStorage.getItem('axis:theme');if(t!=='light'&&t!=='dark'){t='light';}document.documentElement.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-theme','light');}})();`;

/**
 * Early native bootstrap (beforeInteractive).
 * Hides the Capacitor splash as soon as the bridge is up, and retries briefly
 * so a slow bridge inject cannot leave launchAutoHide as the only escape.
 * Also recovers OAuth returns that landed on `/` with ?code= / ?error=.
 */
export const CAPACITOR_BOOTSTRAP_SCRIPT = `(function(){try{var hide=function(){try{var c=window.Capacitor;if(!c||!c.isNativePlatform||!c.isNativePlatform())return false;var m=c.Plugins&&c.Plugins.SplashScreen;if(m&&m.hide){m.hide();return true;}return false;}catch(e){return false;}};var ready=function(){try{var c=window.Capacitor;if(!(c&&c.isNativePlatform&&c.isNativePlatform()))return false;var p=c.getPlatform&&c.getPlatform();document.documentElement.setAttribute('data-native',p==='android'?'android':'ios');var vp=document.querySelector('meta[name="viewport"]');if(vp)vp.setAttribute('content','width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover');hide();var u=new URL(location.href);if((u.pathname==='/'||u.pathname==='')&&(u.searchParams.get('code')||u.searchParams.get('error'))){u.pathname='/auth/callback';location.replace(u.pathname+u.search+u.hash);}return true;}catch(e){return false;}};if(ready()){window.addEventListener('load',hide);setTimeout(hide,2500);return;}var n=0;var t=setInterval(function(){n+=1;if(ready()||n>=20){clearInterval(t);window.addEventListener('load',hide);setTimeout(hide,2500);}},100);}catch(e){}})();`;
