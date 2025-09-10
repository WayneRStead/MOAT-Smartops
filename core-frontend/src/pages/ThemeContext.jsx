// src/ThemeContext.jsx (snippet)
const ThemeCtx = React.createContext({ org: null, setOrg: () => {} });
// ...
const [org, setOrg] = useState(null);
return <ThemeCtx.Provider value={{ org, setOrg }}>{children}</ThemeCtx.Provider>;
