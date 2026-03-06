import type { InstallationContext, PackageSource } from '../../unified/context.js';
import type { ExecutionContext } from '../../../../types/index.js';
import type { 
  NormalizedInstallOptions, 
  InputClassification, 
  PreprocessResult 
} from '../types.js';
import type { UnifiedSpinner } from '../../../ports/output.js';
import { BaseInstallStrategy } from './base.js';
import { getLoaderForSource } from '../../sources/loader-factory.js';
import { createResolvedPackageFromLoaded } from '../../preprocessing/context-population.js';
import { normalizePlatforms } from '../../../platform/platform-mapper.js';
import { logger } from '../../../../utils/logger.js';
import { applyBaseDetection, computePathScoping } from '../../preprocessing/base-resolver.js';
import { runConvenienceFilterInstall } from '../../preprocessing/convenience-preprocessor.js';
import { resolveOutput } from '../../../ports/resolve.js';

export class GitInstallStrategy extends BaseInstallStrategy {
  readonly name = 'git';
  
  canHandle(classification: InputClassification): boolean {
    return classification.type === 'git';
  }
  
  async buildContext(
    classification: InputClassification,
    options: NormalizedInstallOptions,
    execContext: ExecutionContext
  ): Promise<InstallationContext> {
    if (classification.type !== 'git') {
      throw new Error('GitStrategy cannot handle non-git classification');
    }
    
    const source: PackageSource = {
      type: 'git',
      packageName: '', // Populated after loading
      gitUrl: classification.gitUrl,
      gitRef: classification.gitRef,
      resourcePath: classification.resourcePath
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
    // Load the source (forward spinner so git clone shows progress)
    const loader = getLoaderForSource(context.source);
    const loaded = await loader.load(context.source, options, execContext, spinner);
    
    // Update context with loaded info
    context.source.packageName = loaded.packageName;
    context.source.version = loaded.version;
    context.source.contentRoot = loaded.contentRoot;
    context.source.pluginMetadata = loaded.pluginMetadata;
    
    // Store commitSha for marketplace
    if (loaded.sourceMetadata?.commitSha) {
      (context.source as any)._commitSha = loaded.sourceMetadata.commitSha;
    }
    
    // Process base detection (always — needed for basePath in convenience filters)
    const baseResult = applyBaseDetection(context, loaded);

    // Apply resource path scoping (always, if resourcePath)
    const resourcePath = context.source.resourcePath;
    if (resourcePath) {
      await computePathScoping(context, loaded, resourcePath);
    }

    // Populate root resolved package so the pipeline can skip re-loading.
    context.resolvedPackages = [createResolvedPackageFromLoaded(loaded, context)];

    // Convenience filters FIRST — explicit user intent takes priority over source type
    if (options.agents?.length || options.skills?.length || options.rules?.length || options.commands?.length) {
      return this.handleConvenienceFilters(context, loaded, options);
    }

    // Now handle marketplace (only when no convenience filters)
    if (loaded.pluginMetadata?.pluginType === 'marketplace' || baseResult.specialHandling === 'marketplace') {
      return this.createMarketplaceResult(context);
    }

    // Ambiguous base
    if (baseResult.specialHandling === 'ambiguous') {
      return this.createAmbiguousResult(context, baseResult.ambiguousMatches ?? []);
    }

    // Warn about unused --plugins flag
    if (options.plugins?.length && !options.agents && !options.skills) {
      const out = resolveOutput(execContext);
      out.warn('--plugins flag is only used with marketplace sources. Ignoring.');
    }

    return this.createNormalResult(context);
  }
  
  /**
   * Handle convenience filter options.
   * Uses context.detectedBase (from applyBaseDetection) when available.
   */
  private async handleConvenienceFilters(
    context: InstallationContext,
    loaded: any,
    options: NormalizedInstallOptions
  ): Promise<PreprocessResult> {
    const convenienceOptions = {
      agents: options.agents,
      skills: options.skills,
      rules: options.rules,
      commands: options.commands
    };
    const resourceContexts = await runConvenienceFilterInstall(context, loaded, convenienceOptions, {
      useDetectedBase: true
    });
    return this.createMultiResourceResult(context, resourceContexts);
  }
}
