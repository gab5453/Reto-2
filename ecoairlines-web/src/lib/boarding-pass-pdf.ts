import { BRAND } from '../config';
import type { jsPDF } from 'jspdf';
import type { PrintablePass } from './boarding-pass-print';

/**
 * Dibuja los pases del check-in en mostrador (D57) en un PDF: una página A5 apaisada por pasajero y tramo. `jspdf` y `qrcode` se
 * cargan con `import()` SOLO cuando el administrador pulsa el botón (CM-1 = A): no pesan en la web del pasajero ni en la PWA.
 * El PDF se arma en el navegador y no se envía a ningún servidor.
 */
const GREEN = [27, 94, 32] as const; // --green-900
const GREEN_LIGHT = [232, 245, 233] as const; // --green-50
const GREY = [96, 96, 96] as const;
const INK = [20, 20, 20] as const;

/** Ancho del nombre del pasajero: de x = 72 mm a la línea del QR (x = 150 mm), con margen. */
export const NAME_WIDTH = 74;

/**
 * Cómo dibujar el nombre sin invadir la columna del QR: achica la letra (negrita) de 12 a 9 pt y, si aun así no cabe, lo parte en
 * dos líneas de 9 pt (hay lugar antes del recuadro de la ruta).
 */
export function nameLayout(doc: jsPDF, text: string, width = NAME_WIDTH): { size: number; lines: string[] } {
  for (let size = 12; size >= 9; size -= 0.5) {
    if (doc.setFont('helvetica', 'bold').setFontSize(size).getTextWidth(text) <= width) return { size, lines: [text] };
  }
  doc.setFont('helvetica', 'bold').setFontSize(9);
  const lines = doc.splitTextToSize(text, width) as string[];
  return { size: 9, lines: lines.length > 2 ? [lines[0]!, lines.slice(1).join(' ')] : lines };
}

const pad = (n: number) => String(n).padStart(2, '0');
const issued = (d: Date) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

export async function boardingPassesPdf(passes: PrintablePass[], issuedAt = new Date()) {
  const [{ jsPDF }, QRCode] = await Promise.all([import('jspdf'), import('qrcode')]);
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a5' });
  doc.setProperties({ title: `Pases de abordar ${passes[0]?.pnr ?? ''}`, creator: BRAND.name });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();

  const label = (text: string, x: number, y: number) => {
    doc.setFont('helvetica', 'normal').setFontSize(7.5).setTextColor(...GREY).text(text.toUpperCase(), x, y);
  };
  const value = (text: string, x: number, y: number, size = 12) => {
    doc.setFont('helvetica', 'bold').setFontSize(size).setTextColor(...INK).text(text, x, y);
  };
  const field = (title: string, text: string, x: number, y: number, size = 12) => {
    label(title, x, y);
    value(text, x, y + 5.5, size);
  };

  for (const [index, pass] of passes.entries()) {
    if (index > 0) doc.addPage();
    // Encabezado con la marca.
    doc.setFillColor(...GREEN).rect(0, 0, W, 24, 'F');
    doc.setTextColor(255, 255, 255).setFont('helvetica', 'bold').setFontSize(20).text(BRAND.name, 12, 13);
    doc.setFont('helvetica', 'normal').setFontSize(8.5).text(BRAND.tagline, 12, 19);
    doc.setFont('helvetica', 'bold').setFontSize(12).text('PASE DE ABORDAR', W - 12, 12, { align: 'right' });
    doc.setFont('helvetica', 'normal').setFontSize(8.5).text('Check-in en mostrador', W - 12, 18, { align: 'right' });

    // Fecha, vuelo y pasajero.
    field('Fecha', pass.date, 12, 33);
    field('Vuelo', pass.flightNumber, 42, 33);
    const name = nameLayout(doc, pass.passengerName);
    label('Pasajero', 72, 33);
    name.lines.forEach((line, i) => value(line, 72, 38.5 + i * 3.8, name.size));

    // Ruta.
    doc.setFillColor(...GREEN_LIGHT).roundedRect(10, 45, 132, 30, 2, 2, 'F');
    doc.setFont('helvetica', 'bold').setFontSize(28).setTextColor(...GREEN).text(pass.origin, 16, 60);
    doc.text(pass.destination, 136, 60, { align: 'right' });
    doc.setDrawColor(...GREEN).setLineWidth(0.6).line(52, 56, 100, 56);
    doc.triangle(100, 54, 100, 58, 104, 56, 'F');
    doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(...INK).text(pass.originCity, 16, 66);
    doc.text(pass.destinationCity, 136, 66, { align: 'right' });
    doc.setFont('helvetica', 'bold').setFontSize(11).text(`Sale ${pass.departureTime}`, 16, 72);
    doc.text(`Llega ${pass.arrivalTime}`, 136, 72, { align: 'right' });
    if (pass.delayed) {
      doc.setFont('helvetica', 'normal').setFontSize(7.5).setTextColor(...GREY).text('Nuevo horario: salida estimada', 78, 72, { align: 'center' });
    }

    // Abordaje.
    field('Embarque', pass.boardingTime, 12, 83, 14);
    field('Cierre de puertas', pass.doorsCloseTime, 42, 83, 14);
    field('Grupo', pass.group, 78, 83, 14);
    field('Asiento', pass.seat, 96, 83, 14);
    field('Posición', pass.position, 122, 83, 14);
    label('Puerta', 12, 98);
    if (pass.gate) value(pass.gate, 12, 103.5, 14);
    else doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(...INK).text('Revisa la puerta en las pantallas del aeropuerto', 12, 103.5);

    // Reserva y equipaje.
    field('Cabina', [pass.cabin, pass.fareBrand].filter(Boolean).join(' · '), 12, 113, 10);
    field('Reserva (PNR)', pass.pnr, 58, 113, 10);
    field('E-ticket', pass.eTicket ?? '—', 92, 113, 10);
    field('Equipaje de mano', pass.carryOn, 12, 126, 10);
    field('Equipaje de bodega', pass.checkedBags, 58, 126, 10);

    // Código QR con el BCBP (IATA Resolución 792) del pase.
    const qr = await QRCode.toDataURL(pass.barcode, { margin: 1, width: 360, errorCorrectionLevel: 'M', color: { dark: '#1B5E20', light: '#FFFFFF' } });
    doc.setDrawColor(...GREEN_LIGHT).setLineWidth(0.4).line(150, 30, 150, H - 14);
    doc.addImage(qr, 'PNG', 157, 36, 44, 44);
    doc.setFont('helvetica', 'normal').setFontSize(7.5).setTextColor(...GREY).text('Muestra este código al abordar', 179, 86, { align: 'center' });

    // Pie.
    doc.setFontSize(7.5).setTextColor(...GREY).text(`Operado por ${BRAND.name}`, 12, H - 7);
    doc.text(`Emitido en mostrador el ${issued(issuedAt)}`, W - 12, H - 7, { align: 'right' });
  }
  return doc;
}

/** Arma el PDF y lo descarga (`pases-<PNR>.pdf`). */
export async function downloadBoardingPasses(passes: PrintablePass[]) {
  const doc = await boardingPassesPdf(passes);
  doc.save(`pases-${passes[0]?.pnr ?? 'reserva'}.pdf`);
}
