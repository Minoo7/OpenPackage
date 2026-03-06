/**
 * PathInstallStrategy handles installs from local directories/tarballs.
 *
 * It preloads the source once and populates the root resolved package so the unified
 * pipeline can skip re-loading.
 * When convenience filters (--agents, --skills, etc.) are specified, routes to
 * multi-resource install like git/registry strategies.
 */
import type { InstallationContext, PackageSource } from '../../unified/context.js';
import type { ExecutionContext } from '../../../../types/index.js';
import type { NormalizedInstallOptions, InputClassification, PreprocessResult } from '../types.js';
import type { UnifiedSpinner } from '../../../ports/output.js';
import { BaseInstallStrategy } from './base.js';
import { getLoaderForSource } from '../../sources/loader-factory.js';
import { createResolvedPackageFromLoaded } from '../../preprocessing/context-population.js';
import { runConvenienceFilterInstall } from '../../preprocessing/convenience-preprocessor.js';
import { normalizePlatforms } from '../../../platform/platform-mapper.js';

export class PathInstallStrategy extends BaseInstallStrategy {
  readonly name = 'path';
  
  canHandle(classification: InputClassification): boolean {
    return classification.type === 'path';
  }
  
  async buildContext(
    classification: InputClassification,
    options: NormalizedInstallOptions,
    execContext: ExecutionContext
  ): Promise<InstallationContext> {
    if (classification.type !== 'path') {
      throw new Error('PathStrategy cannot handle non-path classification');
    }
    
    const source: PackageSource = {
      type: 'path',
      packageName: '',
      localPath: classification.localPath,
      sourceType: 'directory' // Could detect tarball here
    };
    
    return {
      execution: execContext,
      targetDir: execContext.targetDir,
      source,
      mode: 'install',
      options,
      platforms: normalizePlatforms(options.platforms) || [],
      resolvedPackages: [],
      warnings: [],
      errors: []
    };
  }
  
  async preprocess(
    context: InstallationContext,
    options: NormalizedInstallOptions,
    execContext: ExecutionContext,
    spinner?: UnifiedSpinner
  ): Promise<PreprocessResult> {
    const loader = getLoaderForSource(context.source);
    const loaded = await loader.load(context.source, options, execContext, spinner);
    
    context.source.packageName = loaded.packageName;
    context.source.version = loaded.version;
    context.source.contentRoot = loaded.contentRoot;
    context.source.pluginMetadata = loaded.pluginMetadata;
    context.resolvedPackages = [createResolvedPackageFromLoaded(loaded, context)];

    // Convenience filters take priority over marketplace routing
    if (options.agents?.length || options.skills?.length || options.rules?.length || options.commands?.length) {
      const convenienceOptions = {
        agents: options.agents,
        skills: options.skills,
        rules: options.rules,
        commands: options.commands
      };
      const resourceContexts = await runConvenienceFilterInstall(context, loaded, convenienceOptions);
      return this.createMultiResourceResult(context, resourceContexts);
    }

    if (loaded.pluginMetadata?.pluginType === 'marketplace') {
      return this.createMarketplaceResult(context);
    }

    return this.createNormalResult(context);
  }
}
