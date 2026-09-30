import type { ITheme } from '@xterm/xterm';

export const terminalThemes: Record<'dark' | 'light', ITheme> = {
  dark:{background:'#18191c',foreground:'#d8dcdf',cursor:'#b9e9cc',selectionBackground:'#44564e',black:'#26282c',red:'#ec9296',green:'#a8d9b6',yellow:'#e3cc91',blue:'#9dbde2',magenta:'#c8a5da',cyan:'#93d2ce',white:'#e7e9ed',brightBlack:'#777e88',brightWhite:'#ffffff'},
  light:{background:'#ffffff',foreground:'#303640',cursor:'#2d7253',cursorAccent:'#ffffff',selectionBackground:'#d1e7da',black:'#303640',red:'#a83f50',green:'#2d7253',yellow:'#806017',blue:'#3b69a0',magenta:'#8453a2',cyan:'#246f72',white:'#4b5563',brightBlack:'#626976',brightRed:'#ab3044',brightGreen:'#24663e',brightYellow:'#795900',brightBlue:'#315ca0',brightMagenta:'#80409c',brightCyan:'#216e71',brightWhite:'#303640'}
};

// Also correct low-contrast 256-color and true-color output from CLI programs.
export const terminalMinimumContrast = 4.5;
