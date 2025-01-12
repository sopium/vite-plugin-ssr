import { loadPageIsomorphicFiles } from '../shared/loadPageIsomorphicFiles'
import { objectAssign } from '../shared/utils'
import { getAllPageFiles } from '../shared/getPageFiles'

export { loadPageFiles }

async function loadPageFiles(pageContext: { _pageId: string }) {
  const pageFiles = {}

  const allPageFiles = await getAllPageFiles()
  objectAssign(pageFiles, { _allPageFiles: allPageFiles })

  const { Page, pageExports, pageIsomorphicFile, pageIsomorphicFileDefault } = await loadPageIsomorphicFiles({
    ...pageContext,
    ...pageFiles
  })
  objectAssign(pageFiles, {
    Page,
    pageExports,
    _pageIsomorphicFile: pageIsomorphicFile,
    _pageIsomorphicFileDefault: pageIsomorphicFileDefault
  })

  return pageFiles
}
