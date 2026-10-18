/** Hand-drawn architectural line work; decoration only, with no image or runtime fetch. */
export function HomeHousingScene() {
  return <div className="home-housing-scene" aria-hidden="true">
    <svg viewBox="0 0 1440 300" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="home-street-wash" x1="720" y1="150" x2="720" y2="300" gradientUnits="userSpaceOnUse"><stop stopColor="#f6fbff" stopOpacity=".85"/><stop offset="1" stopColor="#e8f2fb" stopOpacity=".15"/></linearGradient>
        <g id="home-street-window"><path d="M0 0h24v32H0z" fill="#e2eef9"/><path d="M12 0v32M0 16h24"/></g>
        <g id="home-street-tree"><path d="M0 0v48M0 15l-12-11M0 24l14-12"/><path d="M-2-51c-24 0-36 24-25 40-21 25-9 49 25 47 30 3 46-21 30-43C43-27 22-54-2-51Z" fill="#f1f8fc"/><path d="M0-22v70M0 2l-12-11M0 16l14-12"/></g>
        <g id="home-street-craftsman">
          <path d="M0 66 78 4l80 62v150H0Z" fill="url(#home-street-wash)"/><path d="M-10 66 78-4l90 70M6 61v155h144V61M124 29V5h18v38"/>
          <path d="M22 125h114l16 24H6z" fill="#f2f8fe"/><path d="M14 149v67m128-67v67M8 212h140M0 222h158M18 232h122"/>
          <use href="#home-street-window" x="38" y="72"/><use href="#home-street-window" x="96" y="72"/>
          <path d="M65 164h31v48H65z" fill="#dae9f7"/><path d="M87 187h2M26 165h22v25H26zM113 165h18v25h-18zM20 160v52m116-52v52"/>
          <path d="m63 39 15-12 16 12v16H63zM78 29v26"/>
        </g>
        <g id="home-street-townhouse">
          <path d="M0 35h108v195H0Z" fill="url(#home-street-wash)"/><path d="M-7 35h122M0 43h108M0 107h108M0 169h108M-6 230h120M10 238h88"/>
          <path d="M8 35V20h92v15M20 20V7h68v13"/>
          <use href="#home-street-window" x="16" y="59"/><use href="#home-street-window" x="68" y="59"/>
          <use href="#home-street-window" x="16" y="122"/><use href="#home-street-window" x="68" y="122"/>
          <path d="M16 184h24v33H16zM67 184h27v46H67zM86 207h2"/>
        </g>
        <g id="home-street-message"><path d="M0 7a7 7 0 0 1 7-7h32a7 7 0 0 1 7 7v19a7 7 0 0 1-7 7H17l-9 7v-7H7a7 7 0 0 1-7-7Z" fill="#f7fbff"/><path d="M11 12h24M11 21h16"/></g>
      </defs>
      <g stroke="#7299be" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        <path d="M0 275c198-28 327 4 498 0 203-5 314-13 485-3 165 9 289-18 457-8" opacity=".35"/>
        <g opacity=".5"><path d="M8 244h95V138l36-28 35 28v106h55V165h58v79h54M1105 242h74V123l46-30 44 30v119h67V171h104"/><path d="M1179 136h90M1194 151h14v23h-14zM1237 151h14v23h-14z"/></g>
        <g opacity=".65" transform="translate(85 67) scale(.78)"><use href="#home-street-townhouse"/><use href="#home-street-tree" x="152" y="196"/></g>
        <g transform="translate(347 31)"><use href="#home-street-craftsman"/><use href="#home-street-tree" x="-38" y="191"/></g>
        <g transform="translate(915 23)"><use href="#home-street-townhouse"/><use href="#home-street-tree" x="155" y="200"/></g>
        <g opacity=".65" transform="translate(1200 77) scale(.75)"><use href="#home-street-craftsman"/></g>
      </g>
      <g stroke="#477fc2" strokeWidth="1.2" strokeLinecap="round">
        <path d="M720 47v29c0 72-294 9-294 59M720 47v29c0 72 249 0 249 48" opacity=".5"/>
        <path d="M720 61c-86 133-554 10-589 107M720 61c91 139 498 25 540 124" strokeDasharray="2 7" opacity=".28"/>
        <use href="#home-street-message" x="536" y="80" className="home-housing-message home-housing-message-one"/>
        <use href="#home-street-message" x="829" y="75" className="home-housing-message home-housing-message-two"/>
        <g className="home-housing-hub"><path d="M692 7a12 12 0 0 1 12-12h32a12 12 0 0 1 12 12v27a12 12 0 0 1-12 12h-11l-11 9V46h-10a12 12 0 0 1-12-12Z" fill="#2f5fd0" stroke="#2f5fd0"/><g fill="white" stroke="none"><circle cx="708" cy="20" r="2"/><circle cx="720" cy="20" r="2"/><circle cx="732" cy="20" r="2"/></g></g>
        <g fill="#477fc2" stroke="none"><circle cx="426" cy="135" r="3"/><circle cx="969" cy="124" r="3"/></g>
      </g>
    </svg>
  </div>;
}
