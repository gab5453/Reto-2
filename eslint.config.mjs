// CI-2 (Informacion_General/Pruebas.md §7.1): ESLint con typescript-eslint y reglas que usan los TIPOS, junto a oxlint.
// - oxlint (rápido) corre primero y revisa lo que sabe revisar; `eslint-plugin-oxlint` apaga aquí esas mismas reglas.
// - ESLint aporta lo que oxlint no puede sin tipos: sobre todo `no-floating-promises` (una promesa sin await deja una saga a
//   medias), `no-misused-promises`, `await-thenable` y `no-unnecessary-type-assertion`.
// Necesita la solución compilada (`@ecoairlines/shared` se resuelve a su dist): `npm run lint` va después de `tsc -b`.
import oxlint from 'eslint-plugin-oxlint';
import tseslint from 'typescript-eslint';

const PRUEBAS = ['**/*.spec.ts', '**/*.e2e.ts', '**/test/**/*.ts', 'tests/**/*.ts'];

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'ecoairlines-web/**', 'contract/**', 'historico/**', 'PLAN/**', 'playwright-report/**', 'test-results/**', '**/*.mjs', '**/*.js'],
  },
  // Los comentarios `oxlint-disable`/`eslint-disable` de reglas que corre oxlint no son «sin uso» para ESLint.
  { linterOptions: { reportUnusedDisableDirectives: 'off' } },
  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: { parserOptions: { project: './tsconfig.eslint.json', tsconfigRootDir: import.meta.dirname } },
  },
  // Reglas que oxlint ya revisa: apagadas aquí para no duplicar.
  ...oxlint.buildFromOxlintConfigFile('./oxlint.json'),
  {
    files: ['**/*.ts'],
    rules: {
      // La que más importa (oxlint la declara, pero sin tipos no la puede aplicar bien): aquí es error.
      '@typescript-eslint/no-floating-promises': 'error',
      // El proyecto permite `any` (oxlint.json: no-explicit-any off; las sagas usan `Any` para cuerpos del contrato). Las reglas
      // `no-unsafe-*` son consecuencia directa de eso (~2 000 avisos): cumplirlas es reescribir el tipado, no corregir errores.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      // Métodos `async` sin `await` que piden las interfaces de Nest (guards, repositorios en memoria): no es un error.
      '@typescript-eslint/require-await': 'off',
      // `String(valor)` sobre columnas de la base y JSON (texto o números) es deliberado; los casos en que podía llegar un
      // objeto se corrigieron a mano (CI-2).
      '@typescript-eslint/no-base-to-string': 'off',
    },
  },
  {
    // Pruebas: los mocks de Vitest (`expect(store.metodo)`, `mockImplementation(async …)`) y los errores simulados a propósito
    // (rechazar o lanzar algo que no es Error, como un Fault de SOAP) son falsos positivos de estas reglas.
    files: PRUEBAS,
    rules: {
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
      '@typescript-eslint/only-throw-error': 'off',
      '@typescript-eslint/prefer-promise-reject-errors': 'off',
    },
  },
);
