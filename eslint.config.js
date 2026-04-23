const dclDapps = require('@dcl/eslint-config/dapps.config')

module.exports = [
  ...dclDapps,
  {
    languageOptions: {
      parserOptions: {
        project: ['tsconfig.json']
      }
    },
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'error',
      'import/group-exports': 'off',
      'import/exports-last': 'off'
    }
  },
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/naming-convention': [
        'error',
        { selector: 'enumMember', format: ['UPPER_CASE'] },
        {
          selector: 'objectLiteralProperty',
          format: ['snake_case', 'camelCase', 'UPPER_CASE'],
          filter: {
            regex: '^.+-.+$',
            match: false
          }
        }
      ]
    }
  },
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**']
  }
]
