import { useState } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { BRAND } from '../config';
import { LeafLogo } from './LeafLogo';

const CUSTOMER_LINKS = [
  { to: '/', label: 'Reservar', end: true },
  { to: '/mis-viajes', label: 'Mis viajes' },
  { to: '/check-in', label: 'Check-in' },
  { to: '/estado-de-vuelo', label: 'Estado de vuelo' },
  { to: '/compromiso-verde', label: 'Compromiso verde' },
];

/** Solo se muestran con sesión de administrador; la API exige igualmente el scope ecoairlines:admin. */
const ADMIN_LINKS = [
  { to: '/admin', label: 'Portal admin', end: false },
  { to: '/estado-de-vuelo', label: 'Estado de vuelo' },
];

export function Header() {
  const { user, isAdmin, logout } = useAuth();
  const links = isAdmin ? ADMIN_LINKS : CUSTOMER_LINKS;
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  return (
    <header className="site-header">
      <a className="skip-link" href="#contenido">
        Saltar al contenido
      </a>
      <div className="container header-inner">
        <Link to="/" className="brand" aria-label={`${BRAND.name}, inicio`}>
          <LeafLogo />
          <span>{BRAND.name}</span>
        </Link>

        <button
          type="button"
          className="menu-toggle"
          aria-expanded={open}
          aria-controls="main-nav"
          onClick={() => setOpen((value) => !value)}
        >
          <span aria-hidden="true">☰</span>
          <span className="visually-hidden">Menú</span>
        </button>

        <nav id="main-nav" className={`main-nav ${open ? 'is-open' : ''}`} aria-label="Principal">
          <ul>
            {links.map((link) => (
              <li key={link.to}>
                <NavLink to={link.to} end={link.end} onClick={() => setOpen(false)}>
                  {link.label}
                </NavLink>
              </li>
            ))}
          </ul>
          <div className="session">
            {user ? (
              <>
                {isAdmin ? (
                  <span className="session-name" title={user.email}>Administrador</span>
                ) : (
                  <Link to="/mi-perfil" className="session-name" title={`${user.email} · Mi perfil`} onClick={() => setOpen(false)}>
                    Hola, {user.name.split(' ')[0]}
                  </Link>
                )}
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    logout();
                    setOpen(false);
                    navigate('/');
                  }}
                >
                  Salir
                </button>
              </>
            ) : (
              <Link to="/ingresar" className="btn btn-primary btn-sm" onClick={() => setOpen(false)}>
                Ingresar
              </Link>
            )}
          </div>
        </nav>
      </div>
    </header>
  );
}
