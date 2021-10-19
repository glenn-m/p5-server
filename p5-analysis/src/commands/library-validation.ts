import { Library, Script } from '..';
import { cachedFetch } from './cachedFetch';

export async function checkLibraries() {
  await checkLibraryHomepagePaths();
  await checkLibraryImportPaths();
  await findMinimizedImportPathAlternatives();
}

export async function checkLibraryHomepagePaths() {
  const homepages = await Promise.all(
    Library.all.map(library => cachedFetch(library.homepage))
  );
  const invalid = Library.all.filter((_library, i) => {
    const homepage = homepages[i];
    return homepage.status !== 200;
  });
  if (invalid.length) {
    console.log(`${invalid.length} invalid library homepage paths:`);
    invalid.forEach(library => console.log(library.homepage));
    console.log();
    process.exitCode = 1;
  }
}

export async function checkLibraryImportPaths() {
  const missingImportPaths = Library.all.filter(library => !library.importPath);
  if (missingImportPaths.length) {
    console.log(`These libraries are missing import paths:`);
    missingImportPaths.forEach(library =>
      console.log(' ', `${library.name} (${library.homepage})`)
    );
    console.log();
    process.exitCode = 1;
  }

  process.stdout.write('Fetching sources...');
  const librariesWithPaths = Library.all.filter(library => library.importPath);
  const responses = await Promise.all(
    librariesWithPaths.map(async library => {
      const res = await cachedFetch(library.importPath!);
      return { library, ok: res.ok, text: res.ok ? await res.text() : undefined };
    })
  );
  console.log('done.\n');

  const invalidImportPaths = responses.filter(res => !res.ok);
  if (invalidImportPaths.length) {
    console.log(`These library import paths are invalid:`);
    invalidImportPaths.forEach(({ library }) =>
      console.log(`  ${library.name} (${library.homepage}) – ${library.importPath}`)
    );
    console.log();
    process.exitCode = 1;
  }

  const libraryScripts = responses
    .filter(res => res.ok)
    .map(({ library, text }): [Library, Script] => [library, Script.fromSource(text!)]);
  const scriptErrors = libraryScripts.filter(
    ([, script]) => script.getErrors().length > 0
  );

  for (const [library, script] of scriptErrors) {
    console.log(`${library.name}:`, library.importPath);
    for (const err of script.getErrors()) {
      console.log(' ', err.message);
    }
  }
  if (scriptErrors.length) {
    console.log();
    process.exitCode = 1;
  }

  // for (const [library, script] of libraryScripts.filter(([, script]) => !script.getErrors().length)) {
  //   const globals = Array.from(script.globals.keys());
  //   if (globals.length > 0) {
  //     console.log(library.name + ':', globals.join(', '));
  //   } else {
  //     console.log(library.name + ':', 'none');
  //   }
  // }
}

export async function findMinimizedImportPathAlternatives() {
  const candidates = Library.all.filter(
    library =>
      library.importPath &&
      library.importPath.endsWith('.js') &&
      !library.importPath.endsWith('.min.js')
  );
  const found = (
    await Promise.all(
      candidates.map(async function (library): Promise<[Library, string] | null> {
        const url = library.importPath!.replace(/\.js$/, '.min.js');
        const res = await cachedFetch(url);
        return res.ok ? [library, url] : null;
      })
    )
  ).filter(Boolean) as [Library, string][];

  if (found.length) {
    console.log('These libraries have minimized alternatives:');
    found.forEach(([library, replacement]) =>
      console.log(`${library.name}\n  ${library.importPath} -> ${replacement}`)
    );
  } else {
    console.log('No libraries have minimized alternatives.');
  }
}
