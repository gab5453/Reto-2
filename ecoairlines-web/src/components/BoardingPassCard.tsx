import { cityOf } from '../data/airports';
import { localDate, localTime } from '../lib/format';
import { QrImage } from './QrImage';

export interface BoardingPassView {
  passengerName: string;
  flightNumber?: string;
  origin?: string;
  destination?: string;
  departureAt?: string;
  seat: string;
  boardingGroup?: string | null;
  boardingPosition?: string | null;
  gate?: string | null;
  barcode: string;
}

/** Un pase de abordar: el mismo con conexión (check-in) y sin ella (copia guardada). El QR se genera en el navegador. */
export function BoardingPassCard({ pass }: { pass: BoardingPassView }) {
  return (
    <article className="boarding-pass">
      <header>
        <span>Pase de abordar</span>
        <strong>{pass.flightNumber}</strong>
      </header>
      <div className="pass-body">
        <div>
          <p className="pass-name">{pass.passengerName}</p>
          {pass.origin && pass.destination && (
            <p className="pass-route">
              {pass.origin} → {pass.destination}
              <span className="muted small"> {cityOf(pass.origin)} – {cityOf(pass.destination)}</span>
            </p>
          )}
          {pass.departureAt && <p className="small">{localDate(pass.departureAt)} · Sale {localTime(pass.departureAt)}</p>}
          <dl className="pass-data">
            <div><dt>Asiento</dt><dd>{pass.seat === 'INF' ? 'En brazos' : pass.seat}</dd></div>
            <div><dt>Grupo</dt><dd>{pass.boardingGroup ?? '—'}</dd></div>
            <div><dt>Posición</dt><dd>{pass.boardingPosition ?? '—'}</dd></div>
            {pass.gate && <div><dt>Puerta</dt><dd>{pass.gate}</dd></div>}
          </dl>
        </div>
        <QrImage value={pass.barcode} label={`Código QR del pase de ${pass.passengerName}`} />
      </div>
    </article>
  );
}
